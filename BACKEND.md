# EventBridge backend

The backend accepts the nested DOM tree used by the extension's capture format. Each node retains `id`, `parentId`, `tag`, `text`, and `children`.

## Run with local JSON storage

From the project folder, install dependencies and start the API:

```powershell
npm.cmd install
npm.cmd start
```

The server listens on port 3000 on `127.0.0.1` by default. Set `PORT` to choose another port, for example `$env:PORT = "3001"; npm.cmd start`. It binds to loopback for local use. JSON snapshots are written to `data/snapshots.json`.

Run automated tests with `npm.cmd test`.

## Local dashboard

The dashboard is served at `http://localhost:3000/` (or the configured port). It requires a separate `DASHBOARD_ACCESS_TOKEN` of at least 32 characters. Generate one in PowerShell and start the server in that same terminal:

```powershell
$dashboardToken = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:DASHBOARD_ACCESS_TOKEN = $dashboardToken
$env:PORT = "3000"
npm.cmd start
```

Enter the token in the dashboard login form. The server compares it and sets a four-hour, in-memory session using an `HttpOnly`, `SameSite=Strict` cookie. The token is not embedded in the page or JavaScript, and the dashboard session is separate from both `WEBHOOK_SECRET` and `SNAPSHOT_READ_SECRET`. Restarting the server invalidates sessions. Dashboard event list and detail APIs require that session; list responses contain event metadata only, while authorized detail responses include the original webhook payload. The page keeps its manual refresh control and receives live changes through authenticated Server-Sent Events (SSE).

The dashboard uses `GET /api/dashboard/events` with optional `status`, `limit` (1–100), and `offset` (0–1000000) query parameters. It returns counts for each status and a paginated metadata-only event list. `GET /api/dashboard/events/{eventId}` returns the selected event's stored payload after session authorization. `GET /api/dashboard/events/stream` requires the same dashboard session cookie. It sends event ID, status, creation time, attempt count, and transition action only; webhook payloads are never placed on the stream. The server sends heartbeat comments and an `auth-expired` event when the session expires. The browser's `EventSource` reconnects automatically and refreshes the current event list after reconnecting. The retry button calls the existing `POST /api/webhooks/{eventId}/retry` endpoint with the dashboard session cookie; existing callers can continue using `x-webhook-secret`.

The local server binds to loopback by default. For Docker Compose, set the token in the same PowerShell terminal before startup:

```powershell
$dashboardToken = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:DASHBOARD_ACCESS_TOKEN = $dashboardToken
$env:POSTGRES_PASSWORD = node -p "require('node:crypto').randomBytes(32).toString('hex')"
$env:HOST_PORT = "3000"
docker compose up --build
```

Compose requires `POSTGRES_PASSWORD`; generate a fresh hexadecimal value as shown above and keep it in the same PowerShell session as Compose. It is passed to PostgreSQL and used by the API's connection URL; no database password is committed in the Compose file. Compose publishes the dashboard on host loopback only. It binds the API to the container network internally so the API can reach PostgreSQL. This setup is for local access, not public deployment.

## Connect the Chrome extension

The extension service worker posts captures to `http://localhost:3001/api/snapshots`. Start the API on port 3001, then reload the unpacked extension from `chrome://extensions` so Chrome applies its localhost host permission. Reload the page being captured after reloading the extension. Local storage, pruning, and popup visualization continue to work if the API cannot be reached; failed backend requests are logged by the service worker and can be retried by a later capture. Identical DOM snapshots are only posted once per tab until that tab's captured DOM changes.

To change the API address, update `DEFAULT_API_URL` in `extension/snapshot-sync.js` and the corresponding `host_permissions` entry in `extension/manifest.json`.

Snapshot history contains captured DOM content and requires a server-only read secret. Set it in the backend terminal before starting the server:

```powershell
$env:SNAPSHOT_READ_SECRET = "replace-with-a-long-random-secret"
npm.cmd start
```

For Docker Compose, set `$env:SNAPSHOT_READ_SECRET` in the terminal before `docker compose up --build`; Compose passes it only to the API container.

Use that secret only in trusted administrative tools, never in extension/browser code:

```powershell
$headers = @{ "x-snapshot-read-secret" = $env:SNAPSHOT_READ_SECRET }
Invoke-RestMethod -Method Get -Uri http://localhost:3001/api/snapshots -Headers $headers
```

If `SNAPSHOT_READ_SECRET` is missing, history reads return HTTP 503; missing or incorrect headers return HTTP 401. Snapshot POST remains available to the extension and does not require this read credential.

## API

- `POST /api/snapshots` accepts JSON with `tree` (required), and optional `url`, `title`, `capturedAt`, `nodeCount`, and `truncated`. It returns HTTP 201 and the saved snapshot.
- `GET /api/snapshots` returns `{ "snapshots": [...] }`, newest first, and requires `x-snapshot-read-secret` matching the server-only `SNAPSHOT_READ_SECRET`.
- Invalid JSON/tree data returns HTTP 400. Oversized bodies return HTTP 413. Unknown routes return HTTP 404.

## Webhook intake

`POST /api/webhooks` is a separate intake route and does not change snapshot storage. Configure the shared secret on the backend only; do not put it in the Chrome extension or other frontend code. In PowerShell, set it in the server terminal before starting Node:

```powershell
$env:WEBHOOK_SECRET = "replace-with-a-long-random-secret"
npm.cmd start
```

For Docker Compose, set `$env:WEBHOOK_SECRET` in the terminal before `docker compose up --build`; Compose passes it to the API container. If it is unset or empty, the webhook route returns HTTP 503 and does not accept events. Requests must include the exact `x-webhook-secret` value and a unique `Idempotency-Key` (1–200 printable ASCII characters, without spaces). A successful first delivery returns HTTP 201; a repeated key returns HTTP 200 with the original event ID and status. Events are saved in `data/webhook-events.json` when using JSON storage, or in PostgreSQL's `webhook_events` table when `DATABASE_URL` is configured. New events are persisted as `Received` with attempt count 0 before the request is acknowledged. Processing then runs asynchronously using a deterministic local mock; it changes status to `Processing` and increments the attempt count before the adapter runs, then stores `Completed` or `Failed` with a failure reason. The original payload remains stored. The adapter can be replaced in server construction (the `processWebhookEvent` option); there is no public request switch to force a failure.

Accepted events are scheduled after persistence without depending on the HTTP response finishing, so a client disconnect does not suppress processing. A worker claims the event with a unique owner, updates a processing heartbeat, and passes an `AbortSignal` as the adapter's third argument. Processing defaults to a 30-second timeout and a 120-second stale lease; these can be overridden with `processingTimeoutMs`, `processingLeaseMs`, and `processingHeartbeatMs` when constructing the server. At startup, events whose heartbeat is older than the lease move to `Failed` with a lease-expired reason and can be retried manually. Active workers keep refreshing the lease, while conditional store updates prevent another worker from claiming the same current status.

The processor should honor its `AbortSignal`. If it hangs and ignores cancellation, its worker keeps the claim and heartbeat instead of releasing the event to a concurrent attempt; that event may remain `Processing` until the adapter settles or the process exits. A worker paused longer than the lease can still resume after another process recovers the event; strict fencing of downstream side effects requires the downstream system to honor an idempotency key or fencing token. After a process crash, a stale event can be retried, but a crash after an external side effect and before recording `Completed` may repeat that side effect. Exactly-once downstream effects are not guaranteed. PostgreSQL lease/concurrency behavior is implemented but requires a live PostgreSQL test to verify.

Example request (replace the placeholder with the same value configured in the backend):

```powershell
$headers = @{
  "x-webhook-secret" = "replace-with-a-long-random-secret"
  "Idempotency-Key" = "example-delivery-001"
}
$body = '{"source":"example","action":"created"}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/webhooks `
  -Headers $headers -ContentType "application/json" -Body $body
```

The response contains `eventId`, `createdAt`, `status`, and `duplicate`; the secret is not returned. Missing/incorrect credentials return HTTP 401, missing or invalid idempotency keys and malformed JSON return HTTP 400, and an oversized body returns HTTP 413.

Failed events can be retried with `POST /api/webhooks/{eventId}/retry`, using either the existing `x-webhook-secret` header or a valid dashboard session cookie. The dashboard uses the cookie, so the webhook secret is never sent to browser code. The request does not accept a payload; the server reuses the stored payload. It returns HTTP 202 after atomically moving the event to `Processing` and incrementing the attempt count, then runs the processor asynchronously. Unknown IDs return HTTP 404; events that are not failed or are already processing return HTTP 409. The response includes only the event ID, status, and attempt count.

Run the webhook intake tests with `npm.cmd run test:webhooks`, processing tests with `npm.cmd run test:processing`, retry tests with `npm.cmd run test:retry`, and the full backend and extension test suite with `npm.cmd test`.

For a manual PowerShell check, start the server in one terminal, then run this in another:

```powershell
$body = @{
  url = "https://example.test"
  title = "Example"
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  nodeCount = 2
  truncated = $false
  tree = @{
    id = "1"; parentId = $null; tag = "BODY"; text = ""
    children = @(@{ id = "2"; parentId = "1"; tag = "P"; text = "Hello"; children = @() })
  }
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/snapshots -ContentType "application/json" -Body $body
Invoke-RestMethod -Method Get -Uri http://localhost:3000/api/snapshots -Headers @{ "x-snapshot-read-secret" = $env:SNAPSHOT_READ_SECRET }
```

## Run with PostgreSQL and Docker Compose

After Docker Desktop is installed and running, use:

```powershell
docker compose up --build
```

Compose starts PostgreSQL and the API. The database uses a named volume and initializes the `snapshots` and `webhook_events` tables from `db/init.sql`; the API also ensures its tables exist at startup. If host port 3000 is occupied, choose another port, such as `$env:HOST_PORT = "3001"; docker compose up --build`, then use `http://localhost:3001`.

Compose does not contain a fixed database password: you must set `POSTGRES_PASSWORD` in the same PowerShell session before starting it. Keep that value private. This Compose configuration publishes the API only on host loopback and is for local use, not public deployment. To stop Compose services, run `docker compose down`; the named database volume remains. `docker compose down -v` also deletes the local database volume and its data.
