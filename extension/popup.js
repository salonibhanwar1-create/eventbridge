const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const emptyEl = document.getElementById("empty");
const treeEl = document.getElementById("tree");
const sliderEl = document.getElementById("budgetSlider");
const budgetValueEl = document.getElementById("budgetValue");
const statsEl = document.getElementById("stats");
const statTotalEl = document.getElementById("statTotal");
const statKeptTokensEl = document.getElementById("statKeptTokens");
const statKeptCountEl = document.getElementById("statKeptCount");
const statPrunedCountEl = document.getElementById("statPrunedCount");
const statOverEl = document.getElementById("statOver");
const exportBtn = document.getElementById("exportBtn");
const exportStatusEl = document.getElementById("exportStatus");

const defaultBudget =
  typeof DEFAULT_TOKEN_BUDGET === "number" ? DEFAULT_TOKEN_BUDGET : 200;

let currentLatest = null;
let currentPruned = null;
let currentBudget = defaultBudget;
let sliderTimer = null;
let writingStorage = false;

function setBudgetLabel(budget) {
  budgetValueEl.textContent = String(budget);
  sliderEl.value = String(budget);
}

function paintNode(node, labels, visited) {
  const li = document.createElement("li");
  if (!node || typeof node !== "object") {
    li.textContent = "(missing node)";
    return li;
  }
  if (visited.has(node)) {
    li.className = "pruned";
    li.textContent = "(cycle)";
    return li;
  }
  visited.add(node);

  const id = node.id == null || node.id === "" ? "" : String(node.id);
  const state = id && labels[id] ? labels[id] : "unknown";
  li.className = state;

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = node.tag ? String(node.tag) : "UNKNOWN";
  li.appendChild(tag);

  const tokens = document.createElement("span");
  tokens.className = "tokens";
  const tokenCount =
    node.tokens == null ? estimateTokens(node.text) : node.tokens;
  tokens.textContent = " " + tokenCount + " tok";
  li.appendChild(tokens);

  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = state === "unknown" ? "" : " " + state;
  li.appendChild(mark);

  if (node.text) {
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = " " + node.text;
    li.appendChild(text);
  }

  if (node.children && node.children.length) {
    const ul = document.createElement("ul");
    for (let i = 0; i < node.children.length; i++) {
      ul.appendChild(paintNode(node.children[i], labels, visited));
    }
    li.appendChild(ul);
  }

  return li;
}

function showView(latestTree, prunedResult, budget) {
  currentLatest = latestTree || null;
  currentPruned = prunedResult || null;
  currentBudget = budget;
  setBudgetLabel(budget);
  treeEl.replaceChildren();
  exportStatusEl.textContent = "";

  const hasTree = latestTree && latestTree.tree;
  emptyEl.hidden = Boolean(hasTree);
  metaEl.hidden = !hasTree;
  statsEl.hidden = !prunedResult;
  exportBtn.disabled = !(prunedResult && prunedResult.tree);

  if (prunedResult) {
    statTotalEl.textContent = String(prunedResult.totalTokens || 0);
    statKeptTokensEl.textContent = String(prunedResult.keptTokens || 0);
    statKeptCountEl.textContent = String(prunedResult.keptCount || 0);
    statPrunedCountEl.textContent = String(prunedResult.prunedCount || 0);
    statOverEl.textContent = prunedResult.overBudget ? "yes" : "no";
    statsEl.classList.toggle("overBudget", Boolean(prunedResult.overBudget));
  }

  if (!hasTree) {
    statusEl.textContent = "Waiting for a page snapshot.";
    return;
  }

  statusEl.textContent = latestTree.title || "Captured page";
  metaEl.textContent =
    (latestTree.url || "") +
    " · " +
    (latestTree.nodeCount || 0) +
    " nodes" +
    (latestTree.truncated ? " (truncated)" : "") +
    (latestTree.capturedAt ? " · " + latestTree.capturedAt : "");

  let labels = {};
  try {
    labels = classifyNodes(latestTree.tree, prunedResult);
  } catch (err) {
    statusEl.textContent = "Could not classify pruned nodes.";
  }

  try {
    treeEl.appendChild(paintNode(latestTree.tree, labels, new Set()));
  } catch (err) {
    emptyEl.hidden = false;
    emptyEl.textContent = "Could not draw the tree.";
  }
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "readonly");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  if (!ok) {
    throw new Error("Clipboard copy was blocked.");
  }
}

function copyText(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () {
        done(null);
      },
      function (err) {
        try {
          fallbackCopy(text);
          done(null);
        } catch (fallbackErr) {
          done(err || fallbackErr);
        }
      }
    );
    return;
  }

  try {
    fallbackCopy(text);
    done(null);
  } catch (err) {
    done(err);
  }
}

function loadAll() {
  chrome.storage.local.get(
    ["latestTree", "prunedResult", "tokenBudget"],
    function (result) {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Could not read saved tree.";
        emptyEl.hidden = false;
        return;
      }
      const budget = clampBudget(
        result.tokenBudget == null ? defaultBudget : result.tokenBudget
      );
      showView(result.latestTree, result.prunedResult, budget);
    }
  );
}

function recomputeFromSlider(budget) {
  const nextBudget = clampBudget(budget);
  setBudgetLabel(nextBudget);
  let prunedResult;
  try {
    prunedResult = pruneTree(
      currentLatest && currentLatest.tree ? currentLatest.tree : null,
      nextBudget
    );
  } catch (err) {
    exportStatusEl.textContent = "Could not recompute pruning.";
    prunedResult = {
      tree: null,
      budget: nextBudget,
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

  writingStorage = true;
  chrome.storage.local.set(
    {
      tokenBudget: nextBudget,
      prunedResult: prunedResult
    },
    function () {
      writingStorage = false;
      if (chrome.runtime.lastError) {
        exportStatusEl.textContent = "Could not save the new budget.";
        return;
      }
      showView(currentLatest, prunedResult, nextBudget);
    }
  );
}

sliderEl.addEventListener("input", function () {
  const budget = clampBudget(sliderEl.value);
  setBudgetLabel(budget);
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(function () {
    recomputeFromSlider(budget);
  }, 100);
});

exportBtn.addEventListener("click", function () {
  const text = buildExportText(currentPruned);
  if (!text || !currentPruned || !currentPruned.tree) {
    exportStatusEl.textContent = "Nothing to export yet.";
    return;
  }
  copyText(text, function (err) {
    exportStatusEl.textContent = err
      ? "Copy failed. You can select the tree text instead."
      : "Copied the pruned tree.";
  });
});

loadAll();

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || writingStorage) {
    return;
  }
  if (changes.latestTree || changes.prunedResult || changes.tokenBudget) {
    loadAll();
  }
});
