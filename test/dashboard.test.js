const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough, Writable } = require("node:stream");
const { createJsonSnapshotStore, createJsonWebhookEventStore, createServer } = require("../index");

const dashboardToken = "dashboard-test-token-which-is-at-least-32-characters-long";
const webhookSecret = "dashboard-webhook-test-secret";
const snapshotSecret = "separate-snapshot-read-secret";

function event(id, status, overrides = {}) {
  return {
    id,
    idempotencyKey: `dashboard-${id}`,
    createdAt: "2026-10-18T10:00:00.000Z",
    payload: { source: "dashboard-test", privateText: "stored payload content" },
    status,
    attemptCount: status === "Received" ? 0 : 1,
    failureReason: status === "Failed" ? "test failure" : null,
    ...overrides
  };
}

async function withApi(run, { initialEvents = [], processWebhookEvent, dashboardSessionTtlMs, dashboardSseHeartbeatMs } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eventbridge-dashboard-"));
  const webhookStore = createJsonWebhookEventStore(path.join(directory, "webhook-events.json"));
  for (const stored of initialEvents) await webhookStore.saveOrGet(stored);
  const server = createServer({
    store: createJsonSnapshotStore(path.join(directory, "snapshots.json")),
    webhookStore,
    webhookSecret,
    snapshotReadSecret: snapshotSecret,
    dashboardAccessToken: dashboardToken,
    processWebhookEvent,
    dashboardSessionTtlMs,
    dashboardSseHeartbeatMs
  });

  function request(method, url, body, headers = {}) {
    const req = new PassThrough();
    req.method = method;
    req.url = url;
    req.headers = { host: "localhost:3000", "content-type": "application/json", ...headers };
    let statusCode;
    let responseHeaders = {};
    let responseBody = "";
    const res = new Writable({ write(chunk, encoding, callback) { responseBody += chunk; callback(); } });
    res.writeHead = (status, resultHeaders) => {
      statusCode = status;
      responseHeaders = resultHeaders;
    };
    const finished = new Promise((resolve, reject) => {
      res.on("finish", resolve);
      res.on("error", reject);
    });
    server.emit("request", req, res);
    req.end(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body));
    return finished.then(() => ({
      status: statusCode,
      headers: responseHeaders,
      raw: responseBody,
      json: () => JSON.parse(responseBody)
    }));
  }

  try {
    await run({ request, webhookStore, server });
  } finally {
    await webhookStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function openEventStream(server, cookie) {
  const req = new PassThrough();
  req.method = "GET";
  req.url = "/api/dashboard/events/stream";
  req.headers = { host: "localhost:3000", cookie };
  let status;
  let headers = {};
  let body = "";
  const response = new Writable({ write(chunk, encoding, callback) { body += chunk; callback(); } });
  response.writeHead = (statusCode, responseHeaders) => {
    status = statusCode;
    headers = responseHeaders;
  };
  server.emit("request", req, response);
  req.end();
  return { request: req, response, get status() { return status; }, get headers() { return headers; }, get body() { return body; } };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function login(request) {
  const response = await request("POST", "/api/dashboard/login", { token: dashboardToken }, { origin: "http://localhost:3000" });
  assert.equal(response.status, 200);
  assert.equal(response.raw.includes(dashboardToken), false);
  assert.match(response.headers["Set-Cookie"], /HttpOnly/);
  assert.match(response.headers["Set-Cookie"], /SameSite=Strict/);
  assert.match(response.headers["Set-Cookie"], /Max-Age=14400/);
  return response.headers["Set-Cookie"].split(";", 1)[0];
}

const ids = {
  received: "113e9138-beb2-4b45-8e90-32c773361a01",
  failed: "223e9138-beb2-4b45-8e90-32c773361a02",
  completed: "333e9138-beb2-4b45-8e90-32c773361a03"
};

test("dashboard login issues an HttpOnly session and event APIs require it", async () => {
  await withApi(async ({ request }) => {
    const denied = await request("GET", "/api/dashboard/events");
    assert.equal(denied.status, 401);
    assert.doesNotMatch(denied.raw, /stored payload content/);

    const badLogin = await request("POST", "/api/dashboard/login", { token: "wrong" }, { origin: "http://localhost:3000" });
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.raw.includes(dashboardToken), false);
    const crossOriginLogin = await request("POST", "/api/dashboard/login", { token: dashboardToken }, { origin: "http://attacker.example" });
    assert.equal(crossOriginLogin.status, 403);
    const missingOriginLogin = await request("POST", "/api/dashboard/login", { token: dashboardToken });
    assert.equal(missingOriginLogin.status, 403);

    const cookie = await login(request);
    const session = await request("GET", "/api/dashboard/session", null, { cookie });
    assert.deepEqual(session.json(), { authenticated: true, configured: true });
  });
});

test("event list supports validated status filters and never includes payloads", async () => {
  await withApi(async ({ request }) => {
    const cookie = await login(request);
    const all = await request("GET", "/api/dashboard/events?limit=2&offset=0", null, { cookie });
    assert.equal(all.status, 200);
    const body = all.json();
    assert.equal(body.total, 3);
    assert.deepEqual(body.summary, { Received: 1, Processing: 0, Completed: 1, Failed: 1 });
    assert.equal(body.events.length, 2);
    assert.equal(Object.hasOwn(body.events[0], "payload"), false);
    assert.equal(JSON.stringify(body).includes("stored payload content"), false);

    const failed = await request("GET", "/api/dashboard/events?status=Failed", null, { cookie });
    assert.equal(failed.status, 200);
    assert.equal(failed.json().total, 1);
    assert.equal(failed.json().events[0].id, ids.failed);
    assert.equal(failed.json().events[0].failureReason, "test failure");

    for (const query of ["?status=Unknown", "?limit=0", "?limit=101", "?offset=-1", "?status=Failed&status=Received", "?payload=true"]) {
      const invalid = await request("GET", `/api/dashboard/events${query}`, null, { cookie });
      assert.equal(invalid.status, 400, query);
    }
  }, {
    initialEvents: [event(ids.received, "Received"), event(ids.failed, "Failed"), event(ids.completed, "Completed")]
  });
});

test("event details require dashboard authorization and return stored payload only when authorized", async () => {
  await withApi(async ({ request }) => {
    const denied = await request("GET", `/api/dashboard/events/${ids.failed}`);
    assert.equal(denied.status, 401);
    assert.equal(denied.raw.includes("stored payload content"), false);

    const cookie = await login(request);
    const detail = await request("GET", `/api/dashboard/events/${ids.failed}`, null, { cookie });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json().event.payload, { source: "dashboard-test", privateText: "stored payload content" });
    assert.equal(Object.hasOwn(detail.json().event, "idempotencyKey"), false);
    assert.equal(Object.hasOwn(detail.json().event, "processingOwner"), false);

    assert.equal((await request("GET", "/api/dashboard/events/not-a-uuid", null, { cookie })).status, 400);
    assert.equal((await request("GET", `/api/dashboard/events/${ids.failed}?include=payload`, null, { cookie })).status, 400);
    assert.equal((await request("GET", "/api/dashboard/events/443e9138-beb2-4b45-8e90-32c773361a04", null, { cookie })).status, 404);
  }, { initialEvents: [event(ids.failed, "Failed")] });
});

test("dashboard session cannot substitute for the separate snapshot-history secret", async () => {
  await withApi(async ({ request }) => {
    const cookie = await login(request);
    const response = await request("GET", "/api/snapshots", null, { cookie });
    assert.equal(response.status, 401);
  });
});

test("dashboard retry button targets the existing retry route and session can authorize it", async () => {
  await withApi(async ({ request, webhookStore }) => {
    const html = await request("GET", "/dashboard");
    const script = await request("GET", "/dashboard.js");
    assert.equal(html.status, 200);
    assert.equal(html.raw.includes(dashboardToken), false);
    assert.match(script.raw, /new EventSource\("\/api\/dashboard\/events\/stream"\)/);
    assert.match(script.raw, /stream\.onopen/);
    assert.match(script.raw, /auth-expired/);
    assert.doesNotMatch(script.raw, /POLL_MS|setInterval/);
    assert.match(script.raw, /event\.status !== "Failed"/);
    assert.match(script.raw, /\/api\/webhooks\/\$\{encodeURIComponent\(id\)\}\/retry/);

    const cookie = await login(request);
    const retry = await request("POST", `/api/webhooks/${ids.failed}/retry`, null, { cookie, origin: "http://localhost:3000" });
    assert.equal(retry.status, 202);
    assert.equal(retry.json().eventId, ids.failed);
    assert.equal(retry.json().attemptCount, 2);
    let retried;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      retried = await webhookStore.getEvent(ids.failed);
      if (retried?.status === "Completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(retried.status, "Completed");
  }, {
    initialEvents: [event(ids.failed, "Failed")],
    processWebhookEvent: async () => ({ accepted: true })
  });
});

test("cookie-authenticated logout and retry reject requests without an Origin header", async () => {
  await withApi(async ({ request }) => {
    const cookie = await login(request);
    const missingOriginLogout = await request("POST", "/api/dashboard/logout", null, { cookie });
    assert.equal(missingOriginLogout.status, 403);
    assert.equal((await request("GET", "/api/dashboard/session", null, { cookie })).json().authenticated, true);

    const missingOriginRetry = await request("POST", `/api/webhooks/${ids.failed}/retry`, null, { cookie });
    assert.equal(missingOriginRetry.status, 403);
    assert.equal((await request("GET", `/api/dashboard/events/${ids.failed}`, null, { cookie })).status, 200);

    const logout = await request("POST", "/api/dashboard/logout", null, { cookie, origin: "http://localhost:3000" });
    assert.equal(logout.status, 200);
    assert.match(logout.headers["Set-Cookie"], /Max-Age=0/);
    assert.equal((await request("GET", "/api/dashboard/session", null, { cookie })).json().authenticated, false);
  }, { initialEvents: [event(ids.failed, "Failed")] });
});

test("authenticated SSE reports lifecycle metadata and retry without exposing payloads", async () => {
  const originalPayload = { source: "sse-test", privateText: "must-not-enter-the-stream" };
  const processedPayloads = [];
  let calls = 0;
  await withApi(async ({ request, server, webhookStore }) => {
    const denied = await request("GET", "/api/dashboard/events/stream");
    assert.equal(denied.status, 401);

    const cookie = await login(request);
    const stream = openEventStream(server, cookie);
    assert.equal(stream.status, 200);
    assert.match(stream.headers["Content-Type"], /text\/event-stream/);
    assert.match(stream.headers["Cache-Control"], /no-store/);

    const accepted = await request("POST", "/api/webhooks", originalPayload, {
      "x-webhook-secret": webhookSecret,
      "idempotency-key": "sse-fail-once"
    });
    assert.equal(accepted.status, 201);
    let stored;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      stored = await webhookStore.getEvent(accepted.json().eventId);
      if (stored?.status === "Failed") break;
      await delay(10);
    }
    assert.equal(stored.status, "Failed");
    assert.equal(stored.attemptCount, 1);
    assert.match(stored.failureReason, /one-time SSE test failure/);

    const retry = await request("POST", `/api/webhooks/${stored.id}/retry`, { replacement: true }, {
      cookie,
      origin: "http://localhost:3000"
    });
    assert.equal(retry.status, 202);
    assert.equal(retry.json().attemptCount, 2);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      stored = await webhookStore.getEvent(stored.id);
      if (stored?.status === "Completed") break;
      await delay(10);
    }
    assert.equal(stored.status, "Completed");
    assert.equal(stored.attemptCount, 2);
    assert.deepEqual(stored.payload, originalPayload);
    assert.deepEqual(processedPayloads, [originalPayload, originalPayload]);

    const updates = [...stream.body.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
    assert.deepEqual(updates.map((update) => update.action), ["received", "processing", "status", "retried", "status"]);
    assert.deepEqual(updates.map((update) => update.status), ["Received", "Processing", "Failed", "Processing", "Completed"]);
    assert.ok(updates.every((update) => !Object.hasOwn(update, "payload")));
    assert.equal(stream.body.includes(originalPayload.privateText), false);
    stream.response.destroy();
  }, {
    dashboardSseHeartbeatMs: 20,
    processWebhookEvent: async (payload) => {
      processedPayloads.push(structuredClone(payload));
      calls += 1;
      if (calls === 1) throw new Error("one-time SSE test failure");
    }
  });
});

test("SSE heartbeats stop when a dashboard connection closes and expired sessions are ended", async () => {
  await withApi(async ({ request, server }) => {
    const cookie = await login(request);
    const stream = openEventStream(server, cookie);
    for (let attempt = 0; attempt < 20 && !stream.body.includes(": heartbeat"); attempt += 1) await delay(5);
    assert.match(stream.body, /: heartbeat/);
    stream.response.destroy();
    const closedBody = stream.body;
    await delay(40);
    assert.equal(stream.body, closedBody);
  }, { dashboardSseHeartbeatMs: 10 });

  await withApi(async ({ request, server }) => {
    const loginResponse = await request("POST", "/api/dashboard/login", { token: dashboardToken }, { origin: "http://localhost:3000" });
    const cookie = loginResponse.headers["Set-Cookie"].split(";", 1)[0];
    const stream = openEventStream(server, cookie);
    await delay(60);
    assert.match(stream.body, /event: auth-expired/);
    assert.equal(stream.response.writableEnded, true);
    assert.equal((await request("GET", "/api/dashboard/events/stream", null, { cookie })).status, 401);
  }, { dashboardSessionTtlMs: 30, dashboardSseHeartbeatMs: 5 });
});

test("dashboard endpoints return 503 when the separate access token is unconfigured", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eventbridge-dashboard-config-"));
  const server = createServer({
    storePath: path.join(directory, "snapshots.json"),
    webhookStorePath: path.join(directory, "webhook-events.json"),
    dashboardAccessToken: ""
  });
  try {
    const req = new PassThrough();
    req.method = "POST";
    req.url = "/api/dashboard/login";
    req.headers = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
    let statusCode;
    let responseBody = "";
    const res = new Writable({ write(chunk, encoding, callback) { responseBody += chunk; callback(); } });
    res.writeHead = (status) => { statusCode = status; };
    const finished = new Promise((resolve) => res.on("finish", resolve));
    server.emit("request", req, res);
    req.end(JSON.stringify({ token: dashboardToken }));
    await finished;
    assert.equal(statusCode, 503);
    assert.match(JSON.parse(responseBody).error, /not configured/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
