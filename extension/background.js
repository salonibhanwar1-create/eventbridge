importScripts("prune.js");
importScripts("snapshot-sync.js");

const snapshotSync = EventBridgeSnapshotSync.createSnapshotSync({
  storage: chrome.storage.local,
  fetch: fetch,
  crypto: crypto,
  TextEncoder: TextEncoder,
  getLastError: function () { return chrome.runtime.lastError; }
});

function resolveBudget(storedValue) {
  if (storedValue == null || storedValue === "") {
    return DEFAULT_TOKEN_BUDGET;
  }
  const n = Number(storedValue);
  if (!isFinite(n) || n < 0) {
    return DEFAULT_TOKEN_BUDGET;
  }
  return Math.floor(n);
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== "DOM_TREE" || !message.payload) {
    return;
  }

  const latestTree = {
    url: message.payload.url || "",
    title: message.payload.title || "",
    capturedAt: message.payload.capturedAt || new Date().toISOString(),
    nodeCount: message.payload.nodeCount || 0,
    truncated: Boolean(message.payload.truncated),
    tree: message.payload.tree || null,
    tabId: sender && sender.tab ? sender.tab.id : null
  };
  let responseSent = false;
  function respond(response) {
    if (responseSent) return;
    responseSent = true;
    sendResponse(response);
  }

  chrome.storage.local.get("tokenBudget", function (stored) {
    const budget = resolveBudget(stored ? stored.tokenBudget : null);
    let prunedResult;
    try {
      prunedResult = pruneTree(latestTree.tree, budget);
    } catch (err) {
      prunedResult = {
        tree: null,
        budget: budget,
        totalTokens: 0,
        keptTokens: 0,
        keptCount: 0,
        prunedCount: 0,
        prunedIds: [],
        keptIds: [],
        overBudget: false,
        error: String(err && err.message ? err.message : err)
      };
    }

    chrome.storage.local.set(
      {
        latestTree: latestTree,
        prunedResult: prunedResult
      },
      function () {
        const ok = !chrome.runtime.lastError;
        if (!ok) {
          respond({ ok: false });
          return;
        }
        // Local capture/pruning is saved first; keep the message open until backend sync settles.
        Promise.resolve()
          .then(function () { return snapshotSync.send(latestTree, latestTree.tabId); })
          .catch(function () { return false; })
          .then(function () { respond({ ok: true }); });
      }
    );
  });

  return true;
});
