const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough, Writable } = require("node:stream");
const { createServer } = require("../index");

const validSnapshot = {
  url: "https://example.test/page",
  title: "Example page",
  capturedAt: "2026-01-02T03:04:05.000Z",
  nodeCount: 2,
  truncated: false,
  tree: {
    id: "1",
    parentId: null,
    tag: "BODY",
    text: "",
    children: [{ id: "2", parentId: "1", tag: "P", text: "Hello", children: [] }]
  }
};
const snapshotSecret = "snapshot-history-test-secret";

async function withApi(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eventbridge-api-"));
  const server = createServer({ storePath: path.join(directory, "snapshots.json"), snapshotReadSecret: snapshotSecret });
  function request(method, route, body, headers = {}) {
    const req = new PassThrough();
    req.method = method;
    req.url = route;
    req.headers = { "content-type": "application/json", ...headers };
    let statusCode;
    let responseBody = "";
    const res = new Writable({ write(chunk, encoding, callback) { responseBody += chunk; callback(); } });
    res.writeHead = (status, headers) => { statusCode = status; res.headers = headers; };
    const finished = new Promise((resolve, reject) => {
      res.on("finish", resolve);
      res.on("error", reject);
    });
    server.emit("request", req, res);
    req.end(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body));
    return finished.then(() => ({ status: statusCode, json: () => JSON.parse(responseBody) }));
  }
  try {
    await run(request);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("POST saves a validated snapshot and GET returns its id/parentId history", async () => {
  await withApi(async (request) => {
    const post = await request("POST", "/api/snapshots", validSnapshot);
    const postBody = await post.json();
    assert.equal(post.status, 201, JSON.stringify(postBody));
    const created = postBody.snapshot;
    assert.equal(created.nodeCount, 2);
    assert.equal(created.tree.children[0].parentId, created.tree.id);

    const get = await request("GET", "/api/snapshots", null, { "x-snapshot-read-secret": snapshotSecret });
    assert.equal(get.status, 200);
    const history = (await get.json()).snapshots;
    assert.equal(history.length, 1);
    assert.equal(history[0].id, created.id);
    assert.equal(history[0].tree.children[0].id, "2");
  });
});

test("snapshot history rejects missing and incorrect authorization without exposing DOM content", async () => {
  await withApi(async (request) => {
    await request("POST", "/api/snapshots", validSnapshot);
    for (const headers of [{}, { "x-snapshot-read-secret": "wrong" }]) {
      const response = await request("GET", "/api/snapshots", null, headers);
      assert.equal(response.status, 401);
      assert.doesNotMatch(JSON.stringify(await response.json()), /Hello/);
    }
    const authorized = await request("GET", "/api/snapshots", null, { "x-snapshot-read-secret": snapshotSecret });
    assert.equal(authorized.status, 200);
    assert.match(JSON.stringify(await authorized.json()), /Hello/);
  });
});

test("POST rejects duplicate node IDs", async () => {
  await withApi(async (request) => {
    const invalid = structuredClone(validSnapshot);
    invalid.tree.children[0].id = "1";
    const response = await request("POST", "/api/snapshots", invalid);
    assert.equal(response.status, 400);
    assert.match((await response.json()).details, /Duplicate node id/);
  });
});

test("POST rejects a parentId that does not match the nested tree", async () => {
  await withApi(async (request) => {
    const invalid = structuredClone(validSnapshot);
    invalid.tree.children[0].parentId = "wrong-parent";
    const response = await request("POST", "/api/snapshots", invalid);
    assert.equal(response.status, 400);
    assert.match((await response.json()).details, /parentId must match/);
  });
});

test("POST rejects malformed JSON and non-JSON bodies", async () => {
  await withApi(async (request) => {
    const malformed = await request("POST", "/api/snapshots", "{");
    assert.equal(malformed.status, 400);

    const missingTree = await request("POST", "/api/snapshots", { title: "No tree" });
    assert.equal(missingTree.status, 400);
    assert.match((await missingTree.json()).details, /tree must be/);
  });
});

test("unknown routes return 404", async () => {
  await withApi(async (request) => {
    const response = await request("GET", "/api/unknown");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "API route not found.");
  });
});
