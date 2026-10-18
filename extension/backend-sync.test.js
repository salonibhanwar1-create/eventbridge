const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");
const { createSnapshotSync, DEFAULT_API_URL } = require("./snapshot-sync.js");

function createStorage() {
  const values = {};
  return {
    values,
    get(key, callback) {
      const result = {};
      if (typeof key === "string") result[key] = values[key];
      else Object.assign(result, values);
      callback(result);
    },
    set(items, callback) {
      Object.assign(values, items);
      if (callback) callback();
    }
  };
}

function sampleSnapshot() {
  return {
    url: "https://example.test/",
    title: "Example",
    capturedAt: "2026-10-18T10:00:00.000Z",
    nodeCount: 2,
    truncated: false,
    tree: {
      id: "1", parentId: null, tag: "BODY", text: "", children: [
        { id: "2", parentId: "1", tag: "P", text: "Hello", children: [] }
      ]
    }
  };
}

function syncOptions(storage, fetch, onError) {
  return { storage, fetch, crypto: webcrypto, TextEncoder, onError };
}

test("posts the backend schema once for an unchanged snapshot", async () => {
  const storage = createStorage();
  const calls = [];
  const sync = createSnapshotSync(syncOptions(storage, async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 201 };
  }));

  const snapshot = sampleSnapshot();
  assert.equal(await sync.send(snapshot, 7), true);
  assert.equal(await sync.send({ ...snapshot, capturedAt: "2026-10-18T10:00:01.000Z" }, 7), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_API_URL);
  assert.equal(calls[0].request.method, "POST");
  const posted = JSON.parse(calls[0].request.body);
  assert.deepEqual(Object.keys(posted).sort(), ["capturedAt", "nodeCount", "title", "tree", "truncated", "url"]);
  assert.equal(posted.tree.children[0].parentId, "1");
});

test("sends an update when the DOM changes", async () => {
  const storage = createStorage();
  let calls = 0;
  const sync = createSnapshotSync(syncOptions(storage, async () => {
    calls += 1;
    return { ok: true, status: 201 };
  }));

  const first = sampleSnapshot();
  const changed = sampleSnapshot();
  changed.tree.children[0].text = "Updated";
  assert.equal(await sync.send(first, 7), true);
  assert.equal(await sync.send(changed, 7), true);
  assert.equal(calls, 2);
});

test("backend errors are swallowed and a later capture can retry", async () => {
  const storage = createStorage();
  let attempts = 0;
  const errors = [];
  const sync = createSnapshotSync(syncOptions(storage, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("backend unavailable");
    return { ok: true, status: 201 };
  }, (error) => errors.push(error)));

  const snapshot = sampleSnapshot();
  assert.equal(await sync.send(snapshot, 7), false);
  assert.equal(await sync.send(snapshot, 7), true);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
});

test("background keeps local storage and pruning working when backend fetch fails", async () => {
  const storage = createStorage();
  let messageListener;
  let postedBody;
  let rejectFetch;
  let responseCalls = 0;
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: { local: storage }
  };
  const context = {
    chrome,
    crypto: webcrypto,
    TextEncoder,
    fetch: (_url, request) => {
      postedBody = JSON.parse(request.body);
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    },
    console: { warn() {} },
    importScripts(file) {
      const target = file === "prune.js" ? "prune.js" : "snapshot-sync.js";
      const source = fs.readFileSync(path.join(__dirname, target), "utf8");
      vm.runInContext(source, context, { filename: target });
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), context, {
    filename: "background.js"
  });

  let response;
  const result = messageListener({ type: "DOM_TREE", payload: sampleSnapshot() }, { tab: { id: 7 } }, (value) => {
    responseCalls += 1;
    response = value;
  });
  assert.equal(result, true);
  assert.equal(response, undefined, "response waits for backend sync to settle");
  assert.ok(storage.values.latestTree);
  assert.ok(storage.values.prunedResult);
  assert.equal(storage.values.prunedResult.tree.id, "1");

  for (let attempt = 0; attempt < 20 && !postedBody; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(postedBody, "background attempted the backend POST");
  assert.equal(postedBody.tree.children[0].parentId, "1");
  assert.equal(responseCalls, 0, "message channel remains open during backend sync");

  rejectFetch(new Error("backend unavailable"));
  for (let attempt = 0; attempt < 20 && responseCalls === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(responseCalls, 1, "message receives exactly one response after backend failure");
  assert.equal(response.ok, true, "local capture remains successful when backend sync fails");
});
