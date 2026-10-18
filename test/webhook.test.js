const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough, Writable } = require("node:stream");
const { createJsonSnapshotStore, createJsonWebhookEventStore, createServer } = require("../index");

const secret = "test-only-webhook-secret";
const snapshotReadSecret = "test-only-snapshot-read-secret";
const payload = { source: "test", value: 42 };
const snapshot = {
  url: "https://example.test",
  title: "Example",
  capturedAt: "2026-01-02T03:04:05.000Z",
  nodeCount: 1,
  truncated: false,
  tree: { id: "root", parentId: null, tag: "BODY", text: "", children: [] }
};

async function withApi(run, { webhookSecret = secret, processWebhookEvent } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eventbridge-webhook-"));
  const snapshotPath = path.join(directory, "snapshots.json");
  const webhookPath = path.join(directory, "webhook-events.json");
  const serverOptions = {
    store: createJsonSnapshotStore(snapshotPath),
    webhookStore: createJsonWebhookEventStore(webhookPath),
    webhookSecret,
    snapshotReadSecret
  };
  if (processWebhookEvent) serverOptions.processWebhookEvent = processWebhookEvent;
  const server = createServer(serverOptions);

  function request(method, route, body, headers = {}) {
    const req = new PassThrough();
    req.method = method;
    req.url = route;
    req.headers = { "content-type": "application/json", ...headers };
    let statusCode;
    let responseBody = "";
    const res = new Writable({ write(chunk, encoding, callback) { responseBody += chunk; callback(); } });
    res.writeHead = (status, responseHeaders) => { statusCode = status; res.headers = responseHeaders; };
    const finished = new Promise((resolve, reject) => {
      res.on("finish", resolve);
      res.on("error", reject);
    });
    server.emit("request", req, res);
    req.end(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body));
    return finished.then(() => ({ status: statusCode, json: () => JSON.parse(responseBody), raw: responseBody }));
  }

  try {
    await run({ request, webhookPath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const authHeaders = (key = "delivery-1") => ({ "x-webhook-secret": secret, "idempotency-key": key });

async function waitForEventStatus(webhookPath, id, status) {
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

test("authenticated webhook acknowledges a new event as Received", async () => {
  await withApi(async ({ request, webhookPath }) => {
    const response = await request("POST", "/api/webhooks", payload, authHeaders());
    const body = response.json();
    assert.equal(response.status, 201);
    assert.match(body.eventId, /^[0-9a-f-]{36}$/i);
    assert.equal(body.status, "Received");
    assert.equal(body.duplicate, false);
    assert.ok(Number.isFinite(Date.parse(body.createdAt)));
    assert.equal(response.raw.includes(secret), false);
    const persisted = await waitForEventStatus(webhookPath, body.eventId, "Completed");
    assert.equal(persisted.attemptCount, 1);
  });
});

test("webhook rejects a missing secret and an incorrect secret", async () => {
  await withApi(async ({ request }) => {
    const missing = await request("POST", "/api/webhooks", payload, { "idempotency-key": "delivery-1" });
    assert.equal(missing.status, 401);
    const incorrect = await request("POST", "/api/webhooks", payload, {
      "x-webhook-secret": "wrong-secret", "idempotency-key": "delivery-1"
    });
    assert.equal(incorrect.status, 401);
    assert.equal(incorrect.raw.includes(secret), false);
  });
});

test("webhook intake fails safely when WEBHOOK_SECRET is not configured", async () => {
  await withApi(async ({ request }) => {
    const response = await request("POST", "/api/webhooks", payload, authHeaders());
    assert.equal(response.status, 503);
    assert.match(response.json().error, /not configured/);
  }, { webhookSecret: null });
});

test("webhook rejects malformed JSON", async () => {
  await withApi(async ({ request }) => {
    const response = await request("POST", "/api/webhooks", "{", authHeaders());
    assert.equal(response.status, 400);
    assert.match(response.json().details, /valid JSON/);
  });
});

test("webhook rejects oversized JSON bodies without persisting an event", async () => {
  await withApi(async ({ request, webhookPath }) => {
    const response = await request("POST", "/api/webhooks", "x".repeat(2 * 1024 * 1024 + 1), authHeaders("oversized"));
    assert.equal(response.status, 413);
    assert.match(response.json().error, /too large/i);
    await assert.rejects(fs.readFile(webhookPath, "utf8"), { code: "ENOENT" });
  });
});

test("webhook requires a valid Idempotency-Key", async () => {
  await withApi(async ({ request }) => {
    const missing = await request("POST", "/api/webhooks", payload, { "x-webhook-secret": secret });
    assert.equal(missing.status, 400);
    const invalid = await request("POST", "/api/webhooks", payload, authHeaders("bad key"));
    assert.equal(invalid.status, 400);
  });
});

test("duplicate webhook delivery returns existing event without adding another record", async () => {
  await withApi(async ({ request, webhookPath }) => {
    const first = await request("POST", "/api/webhooks", payload, authHeaders("same-delivery"));
    const duplicate = await request("POST", "/api/webhooks", { source: "changed retry" }, authHeaders("same-delivery"));
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json().eventId, first.json().eventId);
    assert.ok(["Received", "Processing", "Completed"].includes(duplicate.json().status));
    assert.equal(duplicate.json().duplicate, true);
    await waitForEventStatus(webhookPath, first.json().eventId, "Completed");
    const persisted = JSON.parse(await fs.readFile(webhookPath, "utf8"));
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0].payload, payload);
  });
});

test("existing snapshot API remains available alongside webhook intake", async () => {
  await withApi(async ({ request }) => {
    const post = await request("POST", "/api/snapshots", snapshot);
    assert.equal(post.status, 201);
    const get = await request("GET", "/api/snapshots", null, { "x-snapshot-read-secret": snapshotReadSecret });
    assert.equal(get.status, 200);
    assert.equal(get.json().snapshots.length, 1);
    assert.equal(get.json().snapshots[0].tree.id, "root");
  });
});
