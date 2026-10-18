const DEBOUNCE_MS = 300;
const MAX_NODES = 400;
const MAX_DEPTH = 15;
const MAX_TEXT = 80;
const SKIP_TAGS = {
  SCRIPT: true,
  STYLE: true,
  NOSCRIPT: true,
  LINK: true,
  META: true,
  TEMPLATE: true
};

function debounce(fn, wait) {
  let timer = null;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}

function directText(el) {
  if (!el || !el.childNodes) {
    return "";
  }

  let text = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child && child.nodeType === Node.TEXT_NODE && child.nodeValue) {
      text += child.nodeValue;
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_TEXT) {
    return text.slice(0, MAX_TEXT) + "…";
  }
  return text;
}

function collectTree(root) {
  const visited = new Set();
  const state = { count: 0, truncated: false };

  function walk(el, parentId, depth) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }
    if (!el.isConnected) {
      return null;
    }
    if (visited.has(el)) {
      return null;
    }
    if (depth > MAX_DEPTH || state.count >= MAX_NODES) {
      state.truncated = true;
      return null;
    }

    const tag = el.tagName ? el.tagName.toUpperCase() : "UNKNOWN";
    if (SKIP_TAGS[tag]) {
      return null;
    }

    visited.add(el);
    state.count += 1;
    const id = String(state.count);

    const children = [];
    const kids = el.children;
    if (kids) {
      for (let i = 0; i < kids.length; i++) {
        const child = walk(kids[i], id, depth + 1);
        if (child) {
          children.push(child);
        }
      }
    }

    return {
      id: id,
      parentId: parentId,
      tag: tag,
      text: directText(el),
      children: children
    };
  }

  const tree = walk(root, null, 0);
  return {
    tree: tree,
    nodeCount: state.count,
    truncated: state.truncated
  };
}

function captureAndSend() {
  const root = document.body;
  if (!root) {
    return;
  }

  const snapshot = collectTree(root);
  const message = {
    type: "DOM_TREE",
    payload: {
      url: window.location.href,
      title: document.title || "",
      capturedAt: new Date().toISOString(),
      nodeCount: snapshot.nodeCount,
      truncated: snapshot.truncated,
      tree: snapshot.tree
    }
  };

  try {
    chrome.runtime.sendMessage(message, function () {
      void chrome.runtime.lastError;
    });
  } catch (err) {
    // Happens if the extension was reloaded while this tab stayed open.
  }
}

function startObserver() {
  const root = document.body;
  if (!root) {
    return;
  }

  const sendSoon = debounce(captureAndSend, DEBOUNCE_MS);
  captureAndSend();

  const observer = new MutationObserver(function () {
    if (!document.body) {
      return;
    }
    sendSoon();
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: false
  });
}

if (document.body) {
  startObserver();
} else {
  document.addEventListener("DOMContentLoaded", startObserver, { once: true });
}
