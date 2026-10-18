const DEFAULT_TOKEN_BUDGET = 200;

function estimateTokens(text) {
  if (text == null) {
    text = "";
  }
  return Math.ceil(String(text).length / 4);
}

function compareDropPriority(a, b) {
  if (a.tokens !== b.tokens) {
    return a.tokens - b.tokens;
  }
  if (a.depth !== b.depth) {
    return b.depth - a.depth;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

function pruneTree(root, budget) {
  budget = Number(budget);
  if (!isFinite(budget) || budget < 0) {
    budget = DEFAULT_TOKEN_BUDGET;
  }
  budget = Math.floor(budget);

  const nodes = new Map();
  const visitedObjs = new Set();
  const visitedIds = new Set();
  let fallbackCount = 0;

  function walk(node, parentId, depth) {
    if (node == null || typeof node !== "object") {
      return null;
    }
    if (visitedObjs.has(node)) {
      return null;
    }
    visitedObjs.add(node);

    let id = node.id;
    if (id == null || id === "") {
      fallbackCount += 1;
      id = "__n" + fallbackCount;
    }
    id = String(id);
    if (visitedIds.has(id)) {
      return null;
    }
    visitedIds.add(id);

    const text = node.text == null ? "" : String(node.text);
    const childIds = [];
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < kids.length; i++) {
      const childId = walk(kids[i], id, depth + 1);
      if (childId != null) {
        childIds.push(childId);
      }
    }

    nodes.set(id, {
      id: id,
      parentId: parentId,
      tag: node.tag == null || node.tag === "" ? "UNKNOWN" : String(node.tag),
      text: text,
      tokens: estimateTokens(text),
      depth: depth,
      childIds: childIds
    });
    return id;
  }

  const rootId = walk(root, null, 0);
  if (rootId == null) {
    return {
      tree: null,
      budget: budget,
      totalTokens: 0,
      keptTokens: 0,
      keptCount: 0,
      prunedCount: 0,
      prunedIds: [],
      keptIds: [],
      overBudget: false
    };
  }

  const kept = new Set(nodes.keys());
  let keptTokens = 0;
  nodes.forEach(function (node) {
    keptTokens += node.tokens;
  });
  const totalTokens = keptTokens;

  function isKeptLeaf(id) {
    const node = nodes.get(id);
    for (let i = 0; i < node.childIds.length; i++) {
      if (kept.has(node.childIds[i])) {
        return false;
      }
    }
    return true;
  }

  function pickDropId() {
    let bestId = null;
    let bestNode = null;
    kept.forEach(function (id) {
      if (id === rootId) {
        return;
      }
      if (!isKeptLeaf(id)) {
        return;
      }
      const node = nodes.get(id);
      if (bestNode == null || compareDropPriority(node, bestNode) < 0) {
        bestId = id;
        bestNode = node;
      }
    });
    return bestId;
  }

  while (keptTokens > budget) {
    const dropId = pickDropId();
    if (dropId == null) {
      break;
    }
    keptTokens -= nodes.get(dropId).tokens;
    kept.delete(dropId);
  }

  const prunedIds = [];
  const keptIds = [];
  nodes.forEach(function (_node, id) {
    if (kept.has(id)) {
      keptIds.push(id);
    } else {
      prunedIds.push(id);
    }
  });

  const buildVisited = new Set();
  function build(id) {
    if (!kept.has(id) || buildVisited.has(id)) {
      return null;
    }
    buildVisited.add(id);
    const node = nodes.get(id);
    const children = [];
    for (let i = 0; i < node.childIds.length; i++) {
      const child = build(node.childIds[i]);
      if (child) {
        children.push(child);
      }
    }
    return {
      id: node.id,
      parentId: node.parentId,
      tag: node.tag,
      text: node.text,
      tokens: node.tokens,
      children: children
    };
  }

  return {
    tree: build(rootId),
    budget: budget,
    totalTokens: totalTokens,
    keptTokens: keptTokens,
    keptCount: kept.size,
    prunedCount: prunedIds.length,
    prunedIds: prunedIds,
    keptIds: keptIds,
    overBudget: keptTokens > budget
  };
}

const MIN_TOKEN_BUDGET = 10;
const MAX_TOKEN_BUDGET = 500;

function clampBudget(value) {
  const n = Number(value);
  if (!isFinite(n)) {
    return DEFAULT_TOKEN_BUDGET;
  }
  let v = Math.floor(n);
  if (v < MIN_TOKEN_BUDGET) {
    v = MIN_TOKEN_BUDGET;
  }
  if (v > MAX_TOKEN_BUDGET) {
    v = MAX_TOKEN_BUDGET;
  }
  return v;
}

function collectIds(node, into, visited) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (visited.has(node)) {
    return;
  }
  visited.add(node);
  if (node.id != null && node.id !== "") {
    into.add(String(node.id));
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < kids.length; i++) {
    collectIds(kids[i], into, visited);
  }
}

function classifyNodes(originalRoot, prunedResult) {
  const keptIds = new Set();
  const prunedIds = new Set();
  if (prunedResult) {
    const storedKept = Array.isArray(prunedResult.keptIds) ? prunedResult.keptIds : [];
    const storedPruned = Array.isArray(prunedResult.prunedIds) ? prunedResult.prunedIds : [];
    for (let i = 0; i < storedKept.length; i++) {
      keptIds.add(String(storedKept[i]));
    }
    for (let j = 0; j < storedPruned.length; j++) {
      prunedIds.add(String(storedPruned[j]));
    }
    collectIds(prunedResult.tree, keptIds, new Set());
  }

  const labels = {};
  const visited = new Set();
  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) {
      return;
    }
    visited.add(node);
    if (node.id != null && node.id !== "") {
      const id = String(node.id);
      if (keptIds.has(id)) {
        labels[id] = "kept";
      } else if (prunedIds.has(id)) {
        labels[id] = "pruned";
      } else {
        labels[id] = "unknown";
      }
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i]);
    }
  }
  walk(originalRoot);
  return labels;
}

function formatTreeText(node, indent, visited) {
  indent = indent || "";
  visited = visited || new Set();
  if (node == null || typeof node !== "object") {
    return indent + "(empty tree)";
  }
  if (visited.has(node)) {
    return indent + "(cycle)";
  }
  visited.add(node);

  const tag = node.tag == null || node.tag === "" ? "UNKNOWN" : String(node.tag);
  const tokens = node.tokens == null ? estimateTokens(node.text) : node.tokens;
  const text = node.text ? " " + String(node.text) : "";
  const lines = [indent + tag + " (" + tokens + " tokens)" + text];
  const kids = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < kids.length; i++) {
    lines.push(formatTreeText(kids[i], indent + "  ", visited));
  }
  return lines.join("\n");
}

function buildExportText(prunedResult) {
  if (!prunedResult) {
    return "";
  }
  const lines = [
    "EventBridge pruned tree",
    "budget: " + (prunedResult.budget == null ? "" : prunedResult.budget),
    "totalTokens: " + (prunedResult.totalTokens == null ? 0 : prunedResult.totalTokens),
    "keptTokens: " + (prunedResult.keptTokens == null ? 0 : prunedResult.keptTokens),
    "keptCount: " + (prunedResult.keptCount == null ? 0 : prunedResult.keptCount),
    "prunedCount: " + (prunedResult.prunedCount == null ? 0 : prunedResult.prunedCount),
    "overBudget: " + Boolean(prunedResult.overBudget),
    "",
    formatTreeText(prunedResult.tree)
  ];
  return lines.join("\n");
}

const pruneApi = {
  DEFAULT_TOKEN_BUDGET: DEFAULT_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET: MIN_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET: MAX_TOKEN_BUDGET,
  estimateTokens: estimateTokens,
  pruneTree: pruneTree,
  clampBudget: clampBudget,
  classifyNodes: classifyNodes,
  formatTreeText: formatTreeText,
  buildExportText: buildExportText
};

if (typeof globalThis !== "undefined") {
  globalThis.DEFAULT_TOKEN_BUDGET = DEFAULT_TOKEN_BUDGET;
  globalThis.MIN_TOKEN_BUDGET = MIN_TOKEN_BUDGET;
  globalThis.MAX_TOKEN_BUDGET = MAX_TOKEN_BUDGET;
  globalThis.estimateTokens = estimateTokens;
  globalThis.pruneTree = pruneTree;
  globalThis.clampBudget = clampBudget;
  globalThis.classifyNodes = classifyNodes;
  globalThis.formatTreeText = formatTreeText;
  globalThis.buildExportText = buildExportText;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = pruneApi;
}
