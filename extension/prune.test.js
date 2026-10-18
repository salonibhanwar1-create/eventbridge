const {
  estimateTokens,
  pruneTree,
  DEFAULT_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET,
  clampBudget,
  classifyNodes,
  formatTreeText,
  buildExportText
} = require("./prune.js");

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log("PASS: " + message);
  } else {
    failed += 1;
    console.error("FAIL: " + message);
  }
}

const sampleTree = {
  id: "1",
  tag: "BODY",
  text: "",
  children: [
    { id: "2", tag: "H1", text: "Hello", children: [] },
    { id: "3", tag: "P", text: "This is longer copy", children: [] },
    { id: "4", tag: "SPAN", text: "x", children: [] }
  ]
};

assert(estimateTokens("Hello") === 2, "Hello is 2 tokens");
assert(estimateTokens("This is longer copy") === 5, "paragraph is 5 tokens");
assert(estimateTokens("x") === 1, "x is 1 token");
assert(estimateTokens("") === 0, "empty string is 0 tokens");
assert(estimateTokens(null) === 0, "null text is 0 tokens");
assert(estimateTokens(undefined) === 0, "missing text is 0 tokens");
assert(DEFAULT_TOKEN_BUDGET === 200, "default budget is 200");

const fits = pruneTree(sampleTree, 8);
assert(fits.totalTokens === 8, "sample total tokens is 8");
assert(fits.keptCount === 4, "budget 8 keeps every sample node");
assert(fits.overBudget === false, "budget 8 is not over budget");
assert(JSON.stringify(sampleTree.children[0].text) === '"Hello"', "original tree is not mutated");

const pruned = pruneTree(sampleTree, 6);
assert(pruned.prunedIds.indexOf("4") !== -1, "budget 6 drops SPAN first");
assert(pruned.prunedIds.indexOf("2") !== -1, "budget 6 then drops H1");
assert(pruned.keptCount === 2, "budget 6 keeps BODY and P");
assert(pruned.tree.id === "1", "kept tree still starts at BODY");
assert(pruned.tree.children.length === 1, "BODY keeps one child");
assert(pruned.tree.children[0].id === "3", "kept child is P, so BODY lineage is preserved");
assert(pruned.keptTokens === 5, "kept tokens are BODY 0 + P 5");
assert(pruned.overBudget === false, "budget 6 fits after dropping leaves");

const tiny = pruneTree(
  {
    id: "root",
    tag: "BODY",
    text: "abcdefghij",
    children: [{ id: "child", tag: "SPAN", text: "zzzz", children: [] }]
  },
  1
);
assert(tiny.tree.id === "root", "tiny budget still keeps the root");
assert(tiny.tree.children.length === 0, "tiny budget drops the child leaf first");
assert(tiny.keptTokens === 3, "root text abcdefghij is 3 tokens");
assert(tiny.overBudget === true, "required root chain over budget is reported");

const empty = pruneTree({ id: "e1", tag: "DIV", children: [{ id: "e2", tag: "SPAN" }] }, 10);
assert(empty.totalTokens === 0, "missing text does not throw and counts as 0");
assert(empty.keptCount === 2, "empty-text nodes can stay when budget allows");
assert(empty.overBudget === false, "empty-text tree is not over budget");

const a = { id: "a", tag: "A", text: "aaaa", children: [] };
const b = { id: "b", tag: "B", text: "bbbb", children: [] };
a.children.push(b);
b.children.push(a);
const cyclicRoot = { id: "root", tag: "BODY", text: "", children: [a] };
let cyclic;
let cyclicThrew = false;
try {
  cyclic = pruneTree(cyclicRoot, 100);
} catch (err) {
  cyclicThrew = true;
}
assert(cyclicThrew === false, "circular children do not throw");
assert(cyclic && cyclic.keptCount === 3, "circular walk keeps root, A, and B once");
assert(cyclic.tree.children.length === 1, "cycle is not copied back into the result tree");
assert(cyclic.tree.children[0].children.length === 1, "A keeps B");
assert(cyclic.tree.children[0].children[0].children.length === 0, "B does not point back to A");

const missingRoot = pruneTree(null, 50);
assert(missingRoot.tree === null, "missing root returns a null tree");
assert(missingRoot.overBudget === false, "missing root is not over budget");
assert(Array.isArray(missingRoot.keptIds) && missingRoot.keptIds.length === 0, "missing root has empty keptIds");

assert(pruned.keptIds.indexOf("1") !== -1, "budget 6 keptIds includes BODY");
assert(pruned.keptIds.indexOf("3") !== -1, "budget 6 keptIds includes P");
assert(pruned.keptIds.indexOf("2") === -1, "budget 6 keptIds does not include H1");

const labels = classifyNodes(sampleTree, pruned);
assert(labels["1"] === "kept", "classifier marks BODY as kept");
assert(labels["3"] === "kept", "classifier marks P as kept");
assert(labels["2"] === "pruned", "classifier marks H1 as pruned");
assert(labels["4"] === "pruned", "classifier marks SPAN as pruned");

const exportText = buildExportText(pruned);
assert(exportText.indexOf("BODY (0 tokens)") !== -1, "export includes kept BODY");
assert(exportText.indexOf("This is longer copy") !== -1, "export includes kept paragraph text");
assert(exportText.indexOf("Hello") === -1, "export omits pruned H1 text");
assert(exportText.indexOf("overBudget: false") !== -1, "export includes overBudget");

assert(formatTreeText(null) === "(empty tree)", "formatter handles a missing tree");
assert(clampBudget(200) === 200, "clamp keeps 200");
assert(clampBudget(1) === MIN_TOKEN_BUDGET, "clamp raises values below 10");
assert(clampBudget(999) === MAX_TOKEN_BUDGET, "clamp lowers values above 500");
assert(clampBudget("nope") === DEFAULT_TOKEN_BUDGET, "clamp falls back for invalid values");

console.log("");
console.log("passed=" + passed + " failed=" + failed);
if (failed > 0) {
  process.exit(1);
}
