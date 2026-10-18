(function (root) {
  "use strict";

  const DEFAULT_API_URL = "http://localhost:3001/api/snapshots";
  const FINGERPRINTS_KEY = "backendSnapshotFingerprints";
  const MAX_TRACKED_TABS = 100;

  function readLocal(storage, key, getLastError) {
    return new Promise(function (resolve, reject) {
      try {
        storage.get(key, function (values) {
          const error = getLastError && getLastError();
          if (error) {
            reject(new Error(error.message || String(error)));
          } else {
            resolve(values || {});
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function writeLocal(storage, values, getLastError) {
    return new Promise(function (resolve, reject) {
      try {
        storage.set(values, function () {
          const error = getLastError && getLastError();
          if (error) {
            reject(new Error(error.message || String(error)));
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function fingerprintSnapshot(snapshot, cryptoApi, TextEncoderClass) {
    const stableSnapshot = {
      url: snapshot.url || "",
      title: snapshot.title || "",
      nodeCount: snapshot.nodeCount || 0,
      truncated: Boolean(snapshot.truncated),
      tree: snapshot.tree || null
    };
    const bytes = new TextEncoderClass().encode(JSON.stringify(stableSnapshot));
    const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function createSnapshotSync(options) {
    options = options || {};
    const storage = options.storage;
    const fetchImpl = options.fetch || root.fetch;
    const cryptoApi = options.crypto || root.crypto;
    const TextEncoderClass = options.TextEncoder || root.TextEncoder;
    const apiUrl = options.apiUrl || DEFAULT_API_URL;
    const getLastError = options.getLastError;
    const onError = options.onError || function (error) {
      if (root.console && typeof root.console.warn === "function") {
        root.console.warn("EventBridge could not save this snapshot to the backend.", error);
      }
    };
    const inFlight = new Map();

    async function send(snapshot, tabId) {
      if (!storage || typeof fetchImpl !== "function" || !cryptoApi || !TextEncoderClass || !snapshot || !snapshot.tree) {
        return false;
      }
      const key = tabId == null ? "unknown" : String(tabId);
      let fingerprint;
      try {
        fingerprint = await fingerprintSnapshot(snapshot, cryptoApi, TextEncoderClass);
      } catch (error) {
        onError(error);
        return false;
      }

      let active = inFlight.get(key);
      if (!active) {
        active = new Set();
        inFlight.set(key, active);
      }
      if (active.has(fingerprint)) return false;
      active.add(fingerprint);

      try {
        const stored = await readLocal(storage, FINGERPRINTS_KEY, getLastError);
        const fingerprints = stored[FINGERPRINTS_KEY] && typeof stored[FINGERPRINTS_KEY] === "object"
          ? Object.assign({}, stored[FINGERPRINTS_KEY])
          : {};
        if (fingerprints[key] === fingerprint) return false;

        // Keep the backend payload aligned with validateSnapshot() in the Node API.
        const payload = {
          url: snapshot.url || "",
          title: snapshot.title || "",
          capturedAt: snapshot.capturedAt,
          nodeCount: snapshot.nodeCount,
          truncated: Boolean(snapshot.truncated),
          tree: snapshot.tree
        };
        const response = await fetchImpl(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response || !response.ok) {
          throw new Error("Snapshot API returned HTTP " + (response ? response.status : "no response"));
        }

        fingerprints[key] = fingerprint;
        const keys = Object.keys(fingerprints);
        while (keys.length > MAX_TRACKED_TABS) {
          delete fingerprints[keys.shift()];
        }
        await writeLocal(storage, { [FINGERPRINTS_KEY]: fingerprints }, getLastError);
        return true;
      } catch (error) {
        // Backend outages and permission errors must not interrupt local capture or pruning.
        onError(error);
        return false;
      } finally {
        active.delete(fingerprint);
        if (active.size === 0) inFlight.delete(key);
      }
    }

    return { send: send };
  }

  root.EventBridgeSnapshotSync = {
    DEFAULT_API_URL: DEFAULT_API_URL,
    createSnapshotSync: createSnapshotSync
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.EventBridgeSnapshotSync;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
