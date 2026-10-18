const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough, Writable } = require("node:stream");
const { createJsonSnapshotStore, createJsonWebhookEventStore, createServer } = require("../index");

const secret = "retry-test-secret";
const payload = { source: "retry-test", event: "created", value: { id: 14 } };
const eventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function withApi(run, processWebhookEvent) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eventbridge-retry-"));
  const webhookPath = path.join(directory, "webhook-events.json");
  const server = createServer({
    store: createJsonSnapshotStore(path.join(directory, "snapshots.json")),
    webhookStore: createJsonWebhookEventStore(webhookPath),
    webhookSecret: secret,
    processWebhookEvent
  });

  function request(method, url, body, key) {
    const req = new PassThrough();
    req.method = method;
    req.url = url;
    req.headers = {
      "content-type": "application/json",
      "x-webhook-secret": secret,
      ...(key ? { "idempotency-key": key } : {})
    };
    let statusCode;
    let responseBody = "";
    const res = new Writable({ write(chunk, encoding, callback) { responseBody += chunk; callback(); } });
    res.writeHead = (status) => { statusCode = status; };
    const finished = new Promise((resolve, reject) => {
      res.on("finish", resolve);
      res.on("error", reject);
    });
    server.emit("request", req, res);
    req.end(body == null ? "" : JSON.stringify(body));
    return finished.then(() => ({ status: statusCode, json: () => JSON.parse(responseBody), raw: responseBody }));
  }

  try {
    await run({ request, webhookPath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function waitForEvent(webhookPath, id, status) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
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

function retryUrl(id) {
  return `/api/webhooks/${id}/retry`;
}

test("retry completes a failed event using its stored payload and increments attempts once", async () => {
  const receivedPayloads = [];
  await withApi(async ({ request, webhookPath }) => {
    const accepted = await request("POST", "/api/webhooks", payload, "retry-success");
    assert.equal(accepted.status, 201);
    const initialFailure = await waitForEvent(webhookPath, accepted.json().eventId, "Failed");
    assert.equal(initialFailure.attemptCount, 1);
    assert.match(initialFailure.failureReason, /initial mock failure/);
    assert.deepEqual(initialFailure.payload, payload);

    const retry = await request("POST", retryUrl(accepted.json().eventId));
    assert.equal(retry.status, 202);
    assert.equal(retry.json().eventId, accepted.json().eventId);
    assert.equal(retry.json().status, "Processing");
    assert.equal(retry.json().attemptCount, 2);
    assert.equal(Object.hasOwn(retry.json(), "payload"), false);

    const completed = await waitForEvent(webhookPath, accepted.json().eventId, "Completed");
    assert.equal(completed.attemptCount, 2);
    assert.equal(completed.failureReason, null);
    assert.deepEqual(completed.payload, payload);
    assert.deepEqual(receivedPayloads, [payload, payload]);
  }, async (storedPayload) => {
    receivedPayloads.push(structuredClone(storedPayload));
    if (receivedPayloads.length === 1) throw new Error("initial mock failure");
  });
});

test("a retry that fails again stores the new failure reason and increments the attempt count", async () => {
  let calls = 0;
  await withApi(async ({ request, webhookPath }) => {
    const accepted = await request("POST", "/api/webhooks", payload, "retry-fails-again");
    await waitForEvent(webhookPath, accepted.json().eventId, "Failed");
    const retry = await request("POST", retryUrl(accepted.json().eventId));
    assert.equal(retry.status, 202);

    const failedAgain = await waitForEvent(webhookPath, accepted.json().eventId, "Failed");
    assert.equal(failedAgain.status, "Failed");
    assert.equal(failedAgain.attemptCount, 2);
    assert.match(failedAgain.failureReason, /retry mock failure 2/);
    assert.deepEqual(failedAgain.payload, payload);
    assert.equal(calls, 2);
  }, async () => {
    calls += 1;
    throw new Error(`retry mock failure ${calls}`);
  });
});

test("retry rejects unknown and non-failed events, including an event already processing", async () => {
  let releaseProcessing;
  let signalStarted;
  const processingStarted = new Promise((resolve) => { signalStarted = resolve; });
  const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
  try {
    await withApi(async ({ request, webhookPath }) => {
      const unknown = await request("POST", retryUrl("8a4f6c11-fb18-4a45-bf45-123456789abc"));
      assert.equal(unknown.status, 404);

      const accepted = await request("POST", "/api/webhooks", payload, "retry-non-failed");
      await processingStarted;
      const activeRetry = await request("POST", retryUrl(accepted.json().eventId));
      assert.equal(activeRetry.status, 409);
      assert.match(activeRetry.json().error, /already being processed/);

      releaseProcessing();
      await waitForEvent(webhookPath, accepted.json().eventId, "Completed");
      const completedRetry = await request("POST", retryUrl(accepted.json().eventId));
      assert.equal(completedRetry.status, 409);
      assert.match(completedRetry.json().error, /Only failed/);
    }, async () => {
      signalStarted();
      await processingGate;
    });
  } finally {
    releaseProcessing();
  }
});

test("simultaneous retry requests atomically accept only one processing attempt", async () => {
  let releaseRetry;
  let signalRetryStarted;
  const retryStarted = new Promise((resolve) => { signalRetryStarted = resolve; });
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  let calls = 0;
  try {
    await withApi(async ({ request, webhookPath }) => {
      const accepted = await request("POST", "/api/webhooks", payload, "retry-race");
      await waitForEvent(webhookPath, accepted.json().eventId, "Failed");

      const results = await Promise.all([
        request("POST", retryUrl(accepted.json().eventId)),
        request("POST", retryUrl(accepted.json().eventId))
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [202, 409]);
      await retryStarted;
      assert.equal(calls, 2); // one original failure and one accepted retry
      releaseRetry();

      const completed = await waitForEvent(webhookPath, accepted.json().eventId, "Completed");
      assert.equal(completed.attemptCount, 2);
      assert.deepEqual(completed.payload, payload);
    }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("initial failure before retry race");
      if (calls === 2) {
        signalRetryStarted();
        await retryGate;
      }
    });
  } finally {
    releaseRetry();
  }
});
