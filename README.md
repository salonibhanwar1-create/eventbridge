# EventBridge

EventBridge contains a Chrome extension for capturing and pruning page DOM trees, plus a local Node.js API and authenticated event dashboard.

## Local setup

Use Node.js and npm from the project folder:

```powershell
npm.cmd install
npm.cmd test
$env:PORT = "3000"
npm.cmd start
```

The API and dashboard are available at `http://localhost:3000`. The default server binds to `127.0.0.1` and uses JSON files under the ignored `data/` directory. To use the extension's configured API URL, start on port `3001` instead. Load `extension/` as an unpacked extension in Chrome and reload the page being captured.

The dashboard requires a server-only `DASHBOARD_ACCESS_TOKEN`. Generate one and start the server in the same PowerShell session:

```powershell
$env:DASHBOARD_ACCESS_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
npm.cmd start
```

Enter that token in the dashboard login page. Configure `WEBHOOK_SECRET` for webhook intake and `SNAPSHOT_READ_SECRET` for snapshot history reads; neither belongs in extension or browser code. See [BACKEND.md](BACKEND.md) for API examples, environment setup, authentication details, retry behavior, and troubleshooting.

## PostgreSQL with Docker Compose

After installing and starting Docker Desktop, set the required local secrets and start the stack:

```powershell
$env:POSTGRES_PASSWORD = node -p "require('node:crypto').randomBytes(32).toString('hex')"
$env:WEBHOOK_SECRET = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:SNAPSHOT_READ_SECRET = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:DASHBOARD_ACCESS_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
docker compose up --build
```

Compose publishes the API on host loopback. PostgreSQL initialization and runtime setup are described in [BACKEND.md](BACKEND.md) and [db/init.sql](db/init.sql). Existing database volumes may need an explicit migration when schema changes are introduced; initialization SQL alone does not retrofit every changed constraint.

## Current scope

Webhook processing uses a deterministic local mock adapter. A real downstream integration requires the target system, authentication method, and delivery/failure contract to be specified first. Public deployment and a demo video have not been completed. Local automated tests do not verify Chrome behavior, Docker, PostgreSQL, or deployment.
