const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough, Writable } = require("node:stream");
const { createJsonSnapshotStore, createJsonWebhookEventStore, createServer } = require("../index");

const secret = "processing-test-secret";
const payload = { source: "test", action: "created", nested: { value: 17 } };

async function withApi(run, { processWebhookEvent, onBeforeStart, processingTimeoutMs, processingLeaseMs, processingHeartbeatMs, initialEvents = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eventbridge-processing-"));
  const snapshotPath = path.join(directory, "snapshots.json");
  const webhookPath = path.join(directory, "webhook-events.json");
  const jsonStore = createJsonWebhookEventStore(webhookPath);
  for (const event of initialEvents) await jsonStore.saveOrGet(event);
  const webhookStore = {
    saveOrGet: (...args) => jsonStore.saveOrGet(...args),
    startProcessing: async (...args) => {
      if (onBeforeStart) await onBeforeStart(args[0], webhookPath);
      return jsonStore.startProcessing(...args);
    },
    heartbeat: (...args) => jsonStore.heartbeat(...args),
    recoverStaleProcessing: (...args) => jsonStore.recoverStaleProcessing(...args),
    finishProcessing: (...args) => jsonStore.finishProcessing(...args),
    claimRetry: (...args) => jsonStore.claimRetry(...args),
    close: () => jsonStore.close()
  };
  const server = createServer({
    store: createJsonSnapshotStore(snapshotPath),
    webhookStore,
    webhookSecret: secret,
    processWebhookEvent,
    processingTimeoutMs,
    processingLeaseMs,
    processingHeartbeatMs
  });

  function request(body, key, { disconnectOnResponse = false } = {}) {
    const req = new PassThrough();
    req.method = "POST";
    req.url = "/api/webhooks";
    req.headers = {
      "content-type": "application/json",
      "x-webhook-secret": secret,
      "idempotency-key": key
    };
    let statusCode;
    let responseBody = "";
    let resolveFinished;
    let rejectFinished;
    const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
    let res;
    if (disconnectOnResponse) {
      res = {
        destroyed: false,
        writeHead(status) { statusCode = status; this.destroyed = true; },
        end(chunk) { responseBody += chunk; resolveFinished(); }
      };
    } else {
      res = new Writable({ write(chunk, encoding, callback) { responseBody += chunk; callback(); } });
      res.writeHead = (status) => { statusCode = status; };
      res.on("finish", resolveFinished);
      res.on("error", rejectFinished);
    }
    server.emit("request", req, res);
    req.end(JSON.stringify(body));
    return finished.then(() => ({ status: statusCode, json: () => JSON.parse(responseBody) }));
  }

  try {
    await run({ request, webhookPath, jsonStore });
  } finally {
    await jsonStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function waitForEvent(webhookPath, id, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const events = JSON.parse(await fs.readFile(webhookPath, "utf8"));
      const event = events.find((item) => item.id === id);
      if (event?.status === status) return event;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Webhook event ${id} did not reach ${status}.`);
}

test("processing acknowledges quickly, starts from Received/0, and completes with one attempt", async () => {
  let releaseProcessing;
  let signalStarted;
  let initialEvent;
  const processingStarted = new Promise((resolve) => { signalStarted = resolve; });
  const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
  const calls = [];
  try {
    await withApi(async ({ request, webhookPath }) => {
      const response = await request(payload, "success-1");
      assert.equal(response.status, 201);
      assert.equal(response.json().status, "Received");

      await processingStarted;
      const processing = JSON.parse(await fs.readFile(webhookPath, "utf8"))[0];
      assert.equal(initialEvent.status, "Received");
      assert.equal(initialEvent.attemptCount, 0);
      assert.equal(processing.status, "Processing");
      assert.equal(processing.attemptCount, 1);
      assert.deepEqual(processing.payload, payload);

      releaseProcessing();
      const completed = await waitForEvent(webhookPath, response.json().eventId, "Completed");
      assert.equal(calls.length, 1);
      assert.deepEqual(completed.payload, payload);
      assert.equal(completed.attemptCount, 1);
      assert.equal(completed.failureReason, null);
      assert.equal(completed.status, "Completed");
    }, {
      onBeforeStart: async (id, webhookPath) => {
        const events = JSON.parse(await fs.readFile(webhookPath, "utf8"));
        initialEvent = events.find((item) => item.id === id);
      },
      processWebhookEvent: async (receivedPayload) => {
        calls.push(receivedPayload);
        signalStarted();
        await processingGate;
      }
    });
  } finally {
    releaseProcessing();
  }
});

test("processing failure is persisted with a useful reason and the original payload", async () => {
  await withApi(async ({ request, webhookPath }) => {
    const response = await request(payload, "failure-1");
    assert.equal(response.status, 201);
    const failed = await waitForEvent(webhookPath, response.json().eventId, "Failed");
    assert.equal(failed.status, "Failed");
    assert.equal(failed.attemptCount, 1);
    assert.match(failed.failureReason, /mock downstream failure/);
    assert.deepEqual(failed.payload, payload);
  }, {
    processWebhookEvent: async () => { throw new Error("mock downstream failure"); }
  });
});

test("a disconnected client does not prevent a persisted event from being processed", async () => {
  let calls = 0;
  await withApi(async ({ request, webhookPath }) => {
    const response = await request(payload, "client-disconnect", { disconnectOnResponse: true });
    assert.equal(response.status, 201);
    const completed = await waitForEvent(webhookPath, response.json().eventId, "Completed");
    assert.equal(calls, 1);
    assert.equal(completed.attemptCount, 1);
  }, { processWebhookEvent: async () => { calls += 1; } });
});

test("startup recovery fails a stale Processing event without incrementing attempts", async () => {
  const staleEvent = {
    id: "7dbd87a2-826f-4ef0-8af7-73f629091b46",
    idempotencyKey: "stale-worker",
    createdAt: new Date(Date.now() - 60000).toISOString(),
    payload,
    status: "Processing",
    attemptCount: 2,
    processingOwner: "crashed-worker",
    processingStartedAt: new Date(Date.now() - 60000).toISOString(),
    processingHeartbeatAt: new Date(Date.now() - 60000).toISOString()
  };
  await withApi(async ({ webhookPath }) => {
    const failed = await waitForEvent(webhookPath, staleEvent.id, "Failed");
    assert.equal(failed.attemptCount, 2);
    assert.match(failed.failureReason, /lease expired/);
    assert.equal(failed.processingOwner, null);
  }, { initialEvents: [staleEvent], processingLeaseMs: 1000 });
});

test("active worker heartbeats prevent stale recovery from starting a concurrent attempt", async () => {
  let releaseProcessing;
  let signalStarted;
  const processingStarted = new Promise((resolve) => { signalStarted = resolve; });
  const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
  let calls = 0;
  try {
    await withApi(async ({ request, webhookPath, jsonStore }) => {
      const accepted = await request(payload, "heartbeat-lease");
      await processingStarted;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const recovered = await jsonStore.recoverStaleProcessing(new Date(Date.now() - 60000).toISOString());
      assert.equal(recovered, 0);
      const events = JSON.parse(await fs.readFile(webhookPath, "utf8"));
      assert.equal(events[0].status, "Processing");
      assert.ok(events[0].processingHeartbeatAt);
      assert.equal(calls, 1);
      releaseProcessing();
      const completed = await waitForEvent(webhookPath, accepted.json().eventId, "Completed");
      assert.equal(completed.attemptCount, 1);
      assert.equal(calls, 1);
    }, {
      processingLeaseMs: 60000,
      processingHeartbeatMs: 100,
      processWebhookEvent: async () => {
        calls += 1;
        signalStarted();
        await processingGate;
      }
    });
  } finally {
    releaseProcessing();
  }
});

test("processing timeout aborts a cooperative adapter and persists failure", async () => {
  await withApi(async ({ request, webhookPath }) => {
    const accepted = await request(payload, "processor-timeout");
    const failed = await waitForEvent(webhookPath, accepted.json().eventId, "Failed");
    assert.equal(failed.attemptCount, 1);
    assert.match(failed.failureReason, /timed out/);
  }, {
    processingTimeoutMs: 25,
    processingHeartbeatMs: 5,
    processWebhookEvent: async (_payload, _event, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
});

test("duplicate delivery while processing does not create a second processing job", async () => {
  let releaseProcessing;
  let signalStarted;
  const processingStarted = new Promise((resolve) => { signalStarted = resolve; });
  const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
  let calls = 0;
  try {
    await withApi(async ({ request, webhookPath }) => {
      const first = await request(payload, "duplicate-1");
      assert.equal(first.status, 201);
      await processingStarted;

      const duplicate = await request({ source: "replacement payload" }, "duplicate-1");
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.json().eventId, first.json().eventId);
      assert.equal(duplicate.json().status, "Processing");
      assert.equal(duplicate.json().duplicate, true);
      assert.equal(calls, 1);

      releaseProcessing();
      const completed = await waitForEvent(webhookPath, first.json().eventId, "Completed");
      assert.equal(completed.attemptCount, 1);
      assert.deepEqual(completed.payload, payload);
      assert.equal(calls, 1);
    }, {
      processWebhookEvent: async () => {
        calls += 1;
        signalStarted();
        await processingGate;
      }
    });
  } finally {
    releaseProcessing();
  }
});
