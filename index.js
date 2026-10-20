const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TREE_NODES = 10000;
const MAX_TREE_DEPTH = 100;
const DEFAULT_STORE = path.join(__dirname, "data", "snapshots.json");
const DEFAULT_WEBHOOK_STORE = path.join(__dirname, "data", "webhook-events.json");
const DEFAULT_PROCESSING_TIMEOUT_MS = 30000;
const DEFAULT_PROCESSING_LEASE_MS = 120000;
const DASHBOARD_SESSION_COOKIE = "eventbridge_dashboard_session";
const DASHBOARD_SESSION_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_DASHBOARD_SSE_HEARTBEAT_MS = 15000;
const DASHBOARD_PUBLIC_DIR = path.join(__dirname, "dashboard");
const EVENT_STATUSES = ["Received", "Processing", "Completed", "Failed"];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function normalizedId(value, fieldName) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new ValidationError(`${fieldName} must be a non-empty string or number.`);
  }
  return String(value);
}

function validateSnapshot(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  if (!payload.tree || typeof payload.tree !== "object" || Array.isArray(payload.tree)) {
    throw new ValidationError("tree must be a DOM tree root node.");
  }

  const seen = new Set();
  let nodeCount = 0;
  function visit(node, expectedParentId, depth) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new ValidationError("Every tree node must be an object.");
    }
    if (depth > MAX_TREE_DEPTH) {
      throw new ValidationError(`tree exceeds maximum depth of ${MAX_TREE_DEPTH}.`);
    }
    nodeCount += 1;
    if (nodeCount > MAX_TREE_NODES) {
      throw new ValidationError(`tree exceeds maximum of ${MAX_TREE_NODES} nodes.`);
    }
    const id = normalizedId(node.id, "node.id");
    if (seen.has(id)) throw new ValidationError(`Duplicate node id: ${id}.`);
    seen.add(id);
    const parentId = node.parentId == null ? null : normalizedId(node.parentId, "node.parentId");
    if (parentId !== expectedParentId) {
      throw new ValidationError(`Node ${id} parentId must match its position in children.`);
    }
    if (typeof node.tag !== "string" || node.tag.length > 100) {
      throw new ValidationError(`Node ${id} tag must be a string of at most 100 characters.`);
    }
    if (node.text != null && typeof node.text !== "string") {
      throw new ValidationError(`Node ${id} text must be a string when provided.`);
    }
    if (node.children != null && !Array.isArray(node.children)) {
      throw new ValidationError(`Node ${id} children must be an array.`);
    }
    return {
      id,
      parentId,
      tag: node.tag,
      text: node.text || "",
      children: (node.children || []).map((child) => visit(child, id, depth + 1))
    };
  }

  const tree = visit(payload.tree, null, 0);
  const snapshot = {
    id: crypto.randomUUID(),
    url: payload.url == null ? "" : payload.url,
    title: payload.title == null ? "" : payload.title,
    capturedAt: payload.capturedAt == null ? new Date().toISOString() : payload.capturedAt,
    nodeCount,
    truncated: Boolean(payload.truncated),
    tree,
    createdAt: new Date().toISOString()
  };
  if (typeof snapshot.url !== "string" || snapshot.url.length > 4096) {
    throw new ValidationError("url must be a string of at most 4096 characters.");
  }
  if (typeof snapshot.title !== "string" || snapshot.title.length > 1000) {
    throw new ValidationError("title must be a string of at most 1000 characters.");
  }
  if (typeof snapshot.capturedAt !== "string" || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new ValidationError("capturedAt must be a valid date string.");
  }
  if (payload.nodeCount != null && (!Number.isInteger(payload.nodeCount) || payload.nodeCount !== nodeCount)) {
    throw new ValidationError(`nodeCount must equal the number of tree nodes (${nodeCount}).`);
  }
  return snapshot;
}

function createJsonSnapshotStore(filePath = DEFAULT_STORE) {
  let pending = Promise.resolve();

  async function read() {
    try {
      const contents = await fs.readFile(filePath, "utf8");
      const snapshots = JSON.parse(contents);
      if (!Array.isArray(snapshots)) throw new Error("Snapshot store must contain a JSON array.");
      return snapshots;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  return {
    async list() {
      await pending;
      return (await read()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async save(snapshot) {
      const operation = pending.then(async () => {
        const snapshots = await read();
        snapshots.push(snapshot);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
        try {
          await fs.rename(temporaryPath, filePath);
        } catch (error) {
          // Some restricted Windows filesystems deny rename even within one directory.
          if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
          await fs.writeFile(filePath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
          await fs.unlink(temporaryPath).catch(() => {});
        }
        return snapshot;
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async close() {}
  };
}

function createPostgresSnapshotStore(connectionString) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id UUID PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL,
      node_count INTEGER NOT NULL,
      truncated BOOLEAN NOT NULL,
      tree JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      CHECK (node_count >= 0)
    );
    CREATE INDEX IF NOT EXISTS snapshots_created_at_desc_idx ON snapshots (created_at DESC)
  `);
  return {
    async list() {
      await ready;
      const result = await pool.query(`
        SELECT id, url, title, captured_at AS "capturedAt", node_count AS "nodeCount",
               truncated, tree, created_at AS "createdAt"
        FROM snapshots ORDER BY created_at DESC
      `);
      return result.rows;
    },
    async save(snapshot) {
      await ready;
      const result = await pool.query(`
        INSERT INTO snapshots (id, url, title, captured_at, node_count, truncated, tree, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        RETURNING id, url, title, captured_at AS "capturedAt", node_count AS "nodeCount",
                  truncated, tree, created_at AS "createdAt"
      `, [snapshot.id, snapshot.url, snapshot.title, snapshot.capturedAt, snapshot.nodeCount,
        snapshot.truncated, JSON.stringify(snapshot.tree), snapshot.createdAt]);
      return result.rows[0];
    },
    close() { return pool.end(); }
  };
}

function validateIdempotencyKey(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new ValidationError("Idempotency-Key must be 1 to 200 printable ASCII characters without spaces.");
  }
  return value;
}

function createJsonWebhookEventStore(filePath = DEFAULT_WEBHOOK_STORE) {
  let pending = Promise.resolve();

  async function read() {
    try {
      const contents = await fs.readFile(filePath, "utf8");
      const events = JSON.parse(contents);
      if (!Array.isArray(events)) throw new Error("Webhook event store must contain a JSON array.");
      return events;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function write(events) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      await fs.writeFile(filePath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  function enqueue(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  return {
    async saveOrGet(event) {
      return enqueue(async () => {
        const events = await read();
        const existing = events.find((item) => item.idempotencyKey === event.idempotencyKey);
        if (existing) return { event: existing, created: false };

        events.push(event);
        await write(events);
        return { event, created: true };
      });
    },
    async listEvents({ status = null, limit = 50, offset = 0 } = {}) {
      return enqueue(async () => {
        const events = await read();
        const summary = Object.fromEntries(EVENT_STATUSES.map((value) => [value, 0]));
        for (const event of events) if (Object.hasOwn(summary, event.status)) summary[event.status] += 1;
        const filtered = events.filter((event) => status == null || event.status === status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          summary,
          total: filtered.length,
          events: filtered.slice(offset, offset + limit).map((event) => ({
            id: event.id,
            status: event.status,
            createdAt: event.createdAt,
            attemptCount: event.attemptCount,
            failureReason: event.status === "Failed" ? event.failureReason : null
          }))
        };
      });
    },
    async getEvent(id) {
      return enqueue(async () => (await read()).find((event) => event.id === id) || null);
    },
    async startProcessing(id, owner) {
      return enqueue(async () => {
        const events = await read();
        const index = events.findIndex((item) => item.id === id);
        if (index === -1 || events[index].status !== "Received") return null;
        const now = new Date().toISOString();
        events[index] = {
          ...events[index],
          status: "Processing",
          attemptCount: events[index].attemptCount + 1,
          failureReason: null,
          processingStartedAt: now,
          processingHeartbeatAt: now,
          processingOwner: owner
        };
        await write(events);
        return events[index];
      });
    },
    async heartbeat(id, owner, now = new Date().toISOString()) {
      return enqueue(async () => {
        const events = await read();
        const index = events.findIndex((item) => item.id === id);
        if (index === -1 || events[index].status !== "Processing" || events[index].processingOwner !== owner) return false;
        events[index] = { ...events[index], processingHeartbeatAt: now };
        await write(events);
        return true;
      });
    },
    async claimRetry(id, owner) {
      return enqueue(async () => {
        const events = await read();
        const index = events.findIndex((item) => item.id === id);
        if (index === -1) return { event: null, reason: "not_found" };
        if (events[index].status === "Processing") return { event: null, reason: "processing" };
        if (events[index].status !== "Failed") return { event: null, reason: "not_failed" };
        const now = new Date().toISOString();
        events[index] = {
          ...events[index],
          status: "Processing",
          attemptCount: events[index].attemptCount + 1,
          failureReason: null,
          processingStartedAt: now,
          processingHeartbeatAt: now,
          processingOwner: owner
        };
        await write(events);
        return { event: events[index], reason: null };
      });
    },
    async finishProcessing(id, owner, status, failureReason = null) {
      return enqueue(async () => {
        const events = await read();
        const index = events.findIndex((item) => item.id === id);
        if (index === -1 || events[index].status !== "Processing" || events[index].processingOwner !== owner) return null;
        events[index] = {
          ...events[index], status, failureReason,
          processingOwner: null,
          processingHeartbeatAt: null
        };
        await write(events);
        return events[index];
      });
    },
    async recoverStaleProcessing(staleBefore) {
      return enqueue(async () => {
        const cutoff = Date.parse(staleBefore);
        const events = await read();
        let recovered = 0;
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          const heartbeatAt = Date.parse(event.processingHeartbeatAt || event.processingStartedAt || "");
          if (event.status !== "Processing" || (Number.isFinite(heartbeatAt) && heartbeatAt >= cutoff)) continue;
          events[index] = {
            ...event,
            status: "Failed",
            failureReason: "Processing lease expired; the previous worker stopped heartbeating.",
            processingOwner: null,
            processingHeartbeatAt: null
          };
          recovered += 1;
        }
        if (recovered) await write(events);
        return recovered;
      });
    },
    async close() { await pending; }
  };
}

function createPostgresWebhookEventStore(connectionString) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id UUID PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Received', 'Processing', 'Completed', 'Failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      failure_reason TEXT,
      processing_owner TEXT,
      processing_started_at TIMESTAMPTZ,
      processing_heartbeat_at TIMESTAMPTZ
    );
    ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS failure_reason TEXT;
    ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_owner TEXT;
    ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
    ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_heartbeat_at TIMESTAMPTZ;
    ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_status_check;
    ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
      CHECK (status IN ('Received', 'Processing', 'Completed', 'Failed'));
    CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events (status);
    CREATE INDEX IF NOT EXISTS webhook_events_processing_lease_idx
      ON webhook_events (status, processing_heartbeat_at);
    CREATE INDEX IF NOT EXISTS webhook_events_created_at_desc_idx ON webhook_events (created_at DESC)
  `);
  const columns = `id, idempotency_key AS "idempotencyKey", created_at AS "createdAt",
                   payload, status, attempt_count AS "attemptCount", failure_reason AS "failureReason",
                   processing_owner AS "processingOwner", processing_started_at AS "processingStartedAt",
                   processing_heartbeat_at AS "processingHeartbeatAt"`;

  return {
    async saveOrGet(event) {
      await ready;
      const inserted = await pool.query(`
        INSERT INTO webhook_events (id, idempotency_key, created_at, payload, status, attempt_count)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING ${columns}
      `, [event.id, event.idempotencyKey, event.createdAt, JSON.stringify(event.payload), event.status, event.attemptCount]);
      if (inserted.rows.length) return { event: inserted.rows[0], created: true };

      // ON CONFLICT waits for a concurrent insert to commit before this lookup.
      const existing = await pool.query(`
        SELECT ${columns} FROM webhook_events WHERE idempotency_key = $1
      `, [event.idempotencyKey]);
      if (!existing.rows.length) throw new Error("Webhook event conflict could not be resolved.");
      return { event: existing.rows[0], created: false };
    },
    async listEvents({ status = null, limit = 50, offset = 0 } = {}) {
      await ready;
      const [summaryResult, totalResult, eventsResult] = await Promise.all([
        pool.query("SELECT status, COUNT(*)::int AS count FROM webhook_events GROUP BY status"),
        pool.query("SELECT COUNT(*)::int AS total FROM webhook_events WHERE ($1::text IS NULL OR status = $1)", [status]),
        pool.query(`
          SELECT id, status, created_at AS "createdAt", attempt_count AS "attemptCount",
                 CASE WHEN status = 'Failed' THEN failure_reason ELSE NULL END AS "failureReason"
          FROM webhook_events
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
        `, [status, limit, offset])
      ]);
      const summary = Object.fromEntries(EVENT_STATUSES.map((value) => [value, 0]));
      for (const row of summaryResult.rows) if (Object.hasOwn(summary, row.status)) summary[row.status] = row.count;
      return { summary, total: totalResult.rows[0].total, events: eventsResult.rows };
    },
    async getEvent(id) {
      await ready;
      const result = await pool.query(`
        SELECT id, status, created_at AS "createdAt", attempt_count AS "attemptCount",
               failure_reason AS "failureReason", payload
        FROM webhook_events WHERE id = $1
      `, [id]);
      return result.rows[0] || null;
    },
    async startProcessing(id, owner, now = new Date().toISOString()) {
      await ready;
      const result = await pool.query(`
        UPDATE webhook_events
        SET status = 'Processing', attempt_count = attempt_count + 1, failure_reason = NULL,
            processing_owner = $2, processing_started_at = $3, processing_heartbeat_at = $3
        WHERE id = $1 AND status = 'Received'
        RETURNING ${columns}
      `, [id, owner, now]);
      return result.rows[0] || null;
    },
    async heartbeat(id, owner, now = new Date().toISOString()) {
      await ready;
      const result = await pool.query(`
        UPDATE webhook_events SET processing_heartbeat_at = $3
        WHERE id = $1 AND status = 'Processing' AND processing_owner = $2
        RETURNING id
      `, [id, owner, now]);
      return result.rowCount === 1;
    },
    async claimRetry(id, owner, now = new Date().toISOString()) {
      await ready;
      const claimed = await pool.query(`
        UPDATE webhook_events
        SET status = 'Processing', attempt_count = attempt_count + 1, failure_reason = NULL,
            processing_owner = $2, processing_started_at = $3, processing_heartbeat_at = $3
        WHERE id = $1 AND status = 'Failed'
        RETURNING ${columns}
      `, [id, owner, now]);
      if (claimed.rows.length) return { event: claimed.rows[0], reason: null };

      const current = await pool.query(`SELECT status FROM webhook_events WHERE id = $1`, [id]);
      if (!current.rows.length) return { event: null, reason: "not_found" };
      return {
        event: null,
        reason: current.rows[0].status === "Processing" ? "processing" : "not_failed"
      };
    },
    async finishProcessing(id, owner, status, failureReason = null) {
      await ready;
      const result = await pool.query(`
        UPDATE webhook_events
        SET status = $3, failure_reason = $4, processing_owner = NULL, processing_heartbeat_at = NULL
        WHERE id = $1 AND status = 'Processing' AND processing_owner = $2
        RETURNING ${columns}
      `, [id, owner, status, failureReason]);
      return result.rows[0] || null;
    },
    async recoverStaleProcessing(staleBefore) {
      await ready;
      const result = await pool.query(`
        UPDATE webhook_events
        SET status = 'Failed',
            failure_reason = 'Processing lease expired; the previous worker stopped heartbeating.',
            processing_owner = NULL, processing_heartbeat_at = NULL
        WHERE status = 'Processing'
          AND (COALESCE(processing_heartbeat_at, processing_started_at) IS NULL
               OR COALESCE(processing_heartbeat_at, processing_started_at) < $1)
      `, [staleBefore]);
      return result.rowCount;
    },
    close() { return pool.end(); }
  };
}

function safeSecretMatches(provided, configured) {
  if (typeof provided !== "string" || typeof configured !== "string") return false;
  const providedBuffer = Buffer.from(provided, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  return providedBuffer.length === configuredBuffer.length && crypto.timingSafeEqual(providedBuffer, configuredBuffer);
}

function processingFailureReason(error, secret) {
  const message = error instanceof Error ? error.message : String(error || "Webhook processing failed.");
  const redacted = secret ? message.split(secret).join("[redacted]") : message;
  return (redacted || "Webhook processing failed.").slice(0, 1000);
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function cookieValue(request, cookieName) {
  const header = request.headers?.cookie;
  if (typeof header !== "string") return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== cookieName) continue;
    return item.slice(separator + 1).trim();
  }
  return null;
}

function validEventStatus(status) {
  return EVENT_STATUSES.includes(status);
}

function sameOriginRequest(request) {
  const origin = request.headers?.origin;
  if (typeof origin !== "string") return false;
  try {
    const parsed = new URL(origin);
    const expectedProtocol = request.socket?.encrypted ? "https:" : "http:";
    return parsed.host === request.headers?.host && parsed.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          reject(Object.assign(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`), { statusCode: 413 }));
        }
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new ValidationError("Request body must contain valid JSON."));
      }
    });
    request.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
  });
}

function createServer(options = {}) {
  const connectionString = options.databaseUrl || process.env.DATABASE_URL;
  const store = options.store || (connectionString
    ? createPostgresSnapshotStore(connectionString)
    : createJsonSnapshotStore(options.storePath || DEFAULT_STORE));
  const webhookStore = options.webhookStore || (connectionString
    ? createPostgresWebhookEventStore(connectionString)
    : createJsonWebhookEventStore(options.webhookStorePath || DEFAULT_WEBHOOK_STORE));
  const webhookSecret = Object.hasOwn(options, "webhookSecret") ? options.webhookSecret : process.env.WEBHOOK_SECRET;
  const snapshotReadSecret = Object.hasOwn(options, "snapshotReadSecret") ? options.snapshotReadSecret : process.env.SNAPSHOT_READ_SECRET;
  const dashboardAccessToken = Object.hasOwn(options, "dashboardAccessToken") ? options.dashboardAccessToken : process.env.DASHBOARD_ACCESS_TOKEN;
  const processWebhookEvent = options.processWebhookEvent || (async () => ({ accepted: true }));
  const processingEventIds = new Set();
  const dashboardSessions = new Map();
  const dashboardStreams = new Set();
  const dashboardSessionTtlMs = options.dashboardSessionTtlMs ?? DASHBOARD_SESSION_TTL_SECONDS * 1000;
  const dashboardSseHeartbeatMs = options.dashboardSseHeartbeatMs ?? DEFAULT_DASHBOARD_SSE_HEARTBEAT_MS;
  const processingTimeoutMs = options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
  const processingLeaseMs = options.processingLeaseMs ?? DEFAULT_PROCESSING_LEASE_MS;
  const processingHeartbeatMs = options.processingHeartbeatMs ?? Math.max(1000, Math.floor(processingLeaseMs / 3));
  const recoveryReady = webhookStore.recoverStaleProcessing
    ? webhookStore.recoverStaleProcessing(new Date(Date.now() - processingLeaseMs).toISOString())
    : Promise.resolve(0);

  function dashboardSession(request) {
    const token = cookieValue(request, DASHBOARD_SESSION_COOKIE);
    if (!token) return false;
    const expiry = dashboardSessions.get(token);
    if (!expiry || expiry <= Date.now()) {
      dashboardSessions.delete(token);
      return false;
    }
    return true;
  }

  function dashboardCookie(request, token, maxAge) {
    const secure = request.socket?.encrypted ? "; Secure" : "";
    return `${DASHBOARD_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  function dashboardHeaders(extra = {}) {
    return { "Cache-Control": "no-store", ...extra };
  }

  function closeDashboardStream(stream, endResponse = false) {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.heartbeat);
    dashboardStreams.delete(stream);
    if (endResponse && !stream.response.writableEnded && !stream.response.destroyed) stream.response.end();
  }

  function writeDashboardSse(stream, eventName, data) {
    if (stream.closed || stream.response.destroyed || stream.response.writableEnded) return false;
    try {
      stream.response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      closeDashboardStream(stream);
      return false;
    }
  }

  function publishDashboardUpdate(event, action = "status") {
    if (!event || typeof event.id !== "string") return;
    const update = {
      eventId: event.id,
      status: event.status,
      createdAt: event.createdAt,
      attemptCount: event.attemptCount,
      action
    };
    for (const stream of dashboardStreams) writeDashboardSse(stream, "event-update", update);
  }

  function openDashboardStream(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer"
    });
    response.flushHeaders?.();
    const stream = { request, response, heartbeat: null, closed: false };
    dashboardStreams.add(stream);
    response.on("close", () => closeDashboardStream(stream));
    response.on("error", () => closeDashboardStream(stream));
    request.on("aborted", () => closeDashboardStream(stream, true));
    response.write(": connected\n\n");
    stream.heartbeat = setInterval(() => {
      if (!dashboardSession(request)) {
        writeDashboardSse(stream, "auth-expired", { error: "Dashboard session expired." });
        closeDashboardStream(stream, true);
        return;
      }
      if (stream.closed || response.destroyed || response.writableEnded) {
        closeDashboardStream(stream);
        return;
      }
      try {
        response.write(": heartbeat\n\n");
      } catch {
        closeDashboardStream(stream);
      }
    }, dashboardSseHeartbeatMs);
    stream.heartbeat.unref?.();
  }

  function sendDashboardAsset(response, fileName, contentType) {
    fs.readFile(path.join(DASHBOARD_PUBLIC_DIR, fileName), "utf8").then((contents) => {
      response.writeHead(200, {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store"
      });
      response.end(contents);
    }).catch(() => sendJson(response, 404, { error: "Dashboard asset not found." }));
  }

  async function processClaimedEvent(event, action = "processing") {
    const eventId = event.id;
    const owner = event.processingOwner;
    if (typeof owner !== "string" || owner.length === 0) return;
    if (processingEventIds.has(eventId)) return;
    processingEventIds.add(eventId);
    publishDashboardUpdate(event, action);
    const controller = new AbortController();
    let ownershipLost = false;
    const heartbeat = setInterval(() => {
      Promise.resolve(webhookStore.heartbeat(eventId, owner))
        .then((owned) => {
          if (!owned) {
            ownershipLost = true;
            controller.abort(new Error("Processing lease was lost."));
          }
        })
        .catch(() => {
          // A transient heartbeat error is not proof that the lease is lost.
        });
    }, processingHeartbeatMs);
    heartbeat.unref?.();
    let timedOut = false;
    let timeout;
    try {
      const work = Promise.resolve().then(() => processWebhookEvent(event.payload, event, { signal: controller.signal }));
      // Observe a late rejection if the timeout wins the race.
      work.catch(() => {});
      const result = await Promise.race([
        work.then(() => ({ ok: true }), (error) => ({ ok: false, error })),
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("Webhook processing timed out."));
            resolve({ ok: false, error: new Error(`Processing timed out after ${processingTimeoutMs} ms.`) });
          }, processingTimeoutMs);
          timeout.unref?.();
        })
      ]);
      if (timedOut) {
        // Keep the claim and heartbeat until a timed-out adapter actually settles.
        // This prevents a retry or stale-lease recovery from running beside it.
        await work.catch(() => {});
      }
      clearInterval(heartbeat);
      if (ownershipLost) return;
      if (result.ok) {
        const completed = await webhookStore.finishProcessing(eventId, owner, "Completed");
        if (completed) publishDashboardUpdate(completed);
      } else {
        const failed = await webhookStore.finishProcessing(eventId, owner, "Failed", processingFailureReason(result.error, webhookSecret));
        if (failed) publishDashboardUpdate(failed);
      }
    } catch {
      // Processing runs after acknowledgement; storage or adapter failures must not crash the server.
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      processingEventIds.delete(eventId);
    }
  }

  async function processReceivedEvent(eventId) {
    try {
      await recoveryReady;
      const owner = crypto.randomUUID();
      const event = await webhookStore.startProcessing(eventId, owner);
      if (event) await processClaimedEvent(event);
    } catch {
      // Processing runs after acknowledgement; storage failures must not crash the server.
    }
  }

  function scheduleProcessing(eventId, claimedEvent = null, action = "processing") {
    setImmediate(() => {
      const task = claimedEvent ? processClaimedEvent(claimedEvent, action) : processReceivedEvent(eventId);
      void task.catch(() => {});
    });
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const retryMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)\/retry$/);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      sendDashboardAsset(response, "index.html", "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard.css") {
      sendDashboardAsset(response, "dashboard.css", "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard.js") {
      sendDashboardAsset(response, "dashboard.js", "text/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard/session") {
      sendJson(response, 200, {
        authenticated: dashboardSession(request),
        configured: typeof dashboardAccessToken === "string" && dashboardAccessToken.length >= 32
      }, dashboardHeaders());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/dashboard/login") {
      if (!sameOriginRequest(request)) {
        sendJson(response, 403, { error: "Cross-origin dashboard login is not allowed." }, dashboardHeaders());
        return;
      }
      if (typeof dashboardAccessToken !== "string" || dashboardAccessToken.length < 32) {
        sendJson(response, 503, { error: "Dashboard authentication is not configured with a token of at least 32 characters." }, dashboardHeaders());
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.token !== "string") {
          sendJson(response, 400, { error: "A dashboard token is required." }, dashboardHeaders());
          return;
        }
        if (!safeSecretMatches(body.token, dashboardAccessToken)) {
          sendJson(response, 401, { error: "Invalid dashboard credentials." }, dashboardHeaders());
          return;
        }
        const now = Date.now();
        for (const [session, expiry] of dashboardSessions) if (expiry <= now) dashboardSessions.delete(session);
        const session = crypto.randomBytes(32).toString("base64url");
        const sessionTtlSeconds = Math.ceil(dashboardSessionTtlMs / 1000);
        dashboardSessions.set(session, now + dashboardSessionTtlMs);
        sendJson(response, 200, { authenticated: true }, dashboardHeaders({
          "Set-Cookie": dashboardCookie(request, session, sessionTtlSeconds)
        }));
      } catch (error) {
        sendJson(response, 400, { error: "Invalid dashboard login request." }, dashboardHeaders());
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/dashboard/logout") {
      if (!sameOriginRequest(request)) {
        sendJson(response, 403, { error: "Cross-origin dashboard logout is not allowed." }, dashboardHeaders());
        return;
      }
      dashboardSessions.delete(cookieValue(request, DASHBOARD_SESSION_COOKIE));
      sendJson(response, 200, { authenticated: false }, dashboardHeaders({
        "Set-Cookie": dashboardCookie(request, "", 0)
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard/events/stream") {
      if (!dashboardSession(request)) {
        sendJson(response, 401, { error: "Dashboard authentication required." }, dashboardHeaders());
        return;
      }
      if ([...url.searchParams.keys()].length > 0) {
        sendJson(response, 400, { error: "Event stream does not accept query parameters." }, dashboardHeaders());
        return;
      }
      openDashboardStream(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard/events") {
      if (!dashboardSession(request)) {
        sendJson(response, 401, { error: "Dashboard authentication required." }, dashboardHeaders());
        return;
      }
      const allowedQuery = new Set(["status", "limit", "offset"]);
      if ([...url.searchParams.keys()].some((key) => !allowedQuery.has(key)) ||
          [...allowedQuery].some((key) => url.searchParams.getAll(key).length > 1)) {
        sendJson(response, 400, { error: "Invalid dashboard event query parameters." }, dashboardHeaders());
        return;
      }
      const status = url.searchParams.get("status");
      if (status !== null && !validEventStatus(status)) {
        sendJson(response, 400, { error: "status must be Received, Processing, Completed, or Failed." }, dashboardHeaders());
        return;
      }
      function queryInteger(name, defaultValue, maximum) {
        const raw = url.searchParams.get(name);
        if (raw === null) return defaultValue;
        if (!/^\d+$/.test(raw)) return null;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value <= maximum ? value : null;
      }
      const limit = queryInteger("limit", 50, 100);
      const offset = queryInteger("offset", 0, 1000000);
      if (limit === null || limit < 1 || offset === null) {
        sendJson(response, 400, { error: "limit must be 1–100 and offset must be 0–1000000." }, dashboardHeaders());
        return;
      }
      try {
        const result = await webhookStore.listEvents({ status, limit, offset });
        const summary = Object.fromEntries(EVENT_STATUSES.map((value) => [value, Number(result.summary?.[value] || 0)]));
        const events = result.events.map((event) => ({
          id: event.id,
          status: event.status,
          createdAt: event.createdAt,
          attemptCount: event.attemptCount,
          failureReason: event.status === "Failed" ? event.failureReason || null : null
        }));
        sendJson(response, 200, { summary, total: Number(result.total), events }, dashboardHeaders());
      } catch {
        sendJson(response, 500, { error: "Failed to list webhook events." }, dashboardHeaders());
      }
      return;
    }
    const detailMatch = url.pathname.match(/^\/api\/dashboard\/events\/([^/]+)$/);
    if (request.method === "GET" && detailMatch) {
      if (!dashboardSession(request)) {
        sendJson(response, 401, { error: "Dashboard authentication required." }, dashboardHeaders());
        return;
      }
      if ([...url.searchParams.keys()].length > 0) {
        sendJson(response, 400, { error: "Event detail does not accept query parameters." }, dashboardHeaders());
        return;
      }
      const eventId = detailMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
        sendJson(response, 400, { error: "Invalid event ID." }, dashboardHeaders());
        return;
      }
      try {
        const event = await webhookStore.getEvent(eventId);
        if (!event) {
          sendJson(response, 404, { error: "Webhook event not found." }, dashboardHeaders());
          return;
        }
        sendJson(response, 200, { event: {
          id: event.id,
          status: event.status,
          createdAt: event.createdAt,
          attemptCount: event.attemptCount,
          failureReason: event.failureReason || null,
          payload: event.payload
        } }, dashboardHeaders());
      } catch {
        sendJson(response, 500, { error: "Failed to read webhook event." }, dashboardHeaders());
      }
      return;
    }
    if (retryMatch && request.method === "POST") {
      request.resume();
      const hasDashboardSession = dashboardSession(request);
      if (hasDashboardSession && !sameOriginRequest(request)) {
        sendJson(response, 403, { error: "Cross-origin dashboard retry is not allowed." });
        return;
      }
      if (!hasDashboardSession) {
        if (typeof webhookSecret !== "string" || webhookSecret.length === 0) {
          sendJson(response, 503, { error: "Webhook intake is not configured." });
          return;
        }
        if (!safeSecretMatches(request.headers?.["x-webhook-secret"], webhookSecret)) {
          sendJson(response, 401, { error: "Invalid webhook credentials." });
          return;
        }
      }
      const eventId = retryMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
        sendJson(response, 404, { error: "Webhook event not found." });
        return;
      }
      try {
        await recoveryReady;
        const owner = crypto.randomUUID();
        const result = await webhookStore.claimRetry(eventId, owner);
        if (!result.event) {
          if (result.reason === "not_found") {
            sendJson(response, 404, { error: "Webhook event not found." });
          } else if (result.reason === "processing") {
            sendJson(response, 409, { error: "Webhook event is already being processed." });
          } else {
            sendJson(response, 409, { error: "Only failed webhook events can be retried." });
          }
          return;
        }
        sendJson(response, 202, {
          eventId: result.event.id,
          status: result.event.status,
          attemptCount: result.event.attemptCount
        });
        scheduleProcessing(eventId, result.event, "retried");
      } catch {
        sendJson(response, 500, { error: "Failed to claim webhook event for retry." });
      }
      return;
    }
    if (url.pathname === "/api/webhooks" && request.method === "POST") {
      if (typeof webhookSecret !== "string" || webhookSecret.length === 0) {
        sendJson(response, 503, { error: "Webhook intake is not configured." });
        return;
      }
      if (!safeSecretMatches(request.headers?.["x-webhook-secret"], webhookSecret)) {
        sendJson(response, 401, { error: "Invalid webhook credentials." });
        return;
      }
      try {
        const idempotencyKey = validateIdempotencyKey(request.headers?.["idempotency-key"]);
        const payload = await readJsonBody(request);
        const event = {
          id: crypto.randomUUID(),
          idempotencyKey,
          createdAt: new Date().toISOString(),
          payload,
          status: "Received",
          attemptCount: 0
        };
        const result = await webhookStore.saveOrGet(event);
        sendJson(response, result.created ? 201 : 200, {
          eventId: result.event.id,
          createdAt: result.event.createdAt,
          status: result.event.status,
          duplicate: !result.created
        });
        if (result.created) {
          publishDashboardUpdate(result.event, "received");
          scheduleProcessing(result.event.id);
        }
      } catch (error) {
        if (response.destroyed || response.writableEnded) return;
        if (error instanceof ValidationError) {
          sendJson(response, 400, { error: "Invalid webhook request.", details: error.message });
        } else if (error.statusCode === 413) {
          sendJson(response, 413, { error: "Request body too large.", details: error.message });
        } else {
          sendJson(response, 500, { error: "Failed to persist webhook event." });
        }
      }
      return;
    }
    if (url.pathname === "/api/snapshots" && request.method === "GET") {
      if (typeof snapshotReadSecret !== "string" || snapshotReadSecret.length === 0) {
        sendJson(response, 503, { error: "Snapshot history access is not configured." });
        return;
      }
      if (!safeSecretMatches(request.headers?.["x-snapshot-read-secret"], snapshotReadSecret)) {
        sendJson(response, 401, { error: "Snapshot history authorization required." });
        return;
      }
      try {
        sendJson(response, 200, { snapshots: await store.list() });
      } catch (error) {
        sendJson(response, 500, { error: "Failed to read snapshot history.", details: error.message });
      }
      return;
    }
    if (url.pathname === "/api/snapshots" && request.method === "POST") {
      try {
        const payload = await readJsonBody(request);
        const snapshot = validateSnapshot(payload);
        const saved = await store.save(snapshot);
        sendJson(response, 201, { snapshot: saved });
      } catch (error) {
        if (response.destroyed || response.writableEnded) return;
        if (error instanceof ValidationError) {
          sendJson(response, 400, { error: "Invalid snapshot.", details: error.message });
        } else if (error.statusCode === 413) {
          sendJson(response, 413, { error: "Request body too large.", details: error.message });
        } else {
          sendJson(response, 500, { error: "Failed to save snapshot.", details: error.message });
        }
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API route not found." });
      return;
    }
    sendJson(response, 404, { error: "Route not found." });
  });
  server.on("close", () => {
    for (const stream of dashboardStreams) closeDashboardStream(stream, true);
    Promise.resolve(store.close()).catch(() => {});
    if (webhookStore !== store) Promise.resolve(webhookStore.close()).catch(() => {});
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.BIND_HOST || "0.0.0.0";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("PORT must be an integer from 0 to 65535.");
    process.exitCode = 1;
  } else {
    const server = createServer();
    server.listen(port, host, () => {
      const address = server.address();
      console.log(`EventBridge API listening at http://localhost:${address.port}`);
    });
  }
}

module.exports = {
  createServer,
  createJsonSnapshotStore,
  createPostgresSnapshotStore,
  createJsonWebhookEventStore,
  createPostgresWebhookEventStore,
  validateSnapshot
};
