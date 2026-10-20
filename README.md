EventBridge

EventBridge is a webhook processing and DOM snapshot project featuring a Chrome extension for capturing and pruning page DOM trees, a Node.js API, and an authenticated event dashboard.

Live Deployment

Dashboard: https://eventbridge-wglb.onrender.com

The dashboard is deployed, and dashboard login has been verified. Webhook ingestion, snapshot visibility, and production data persistence still require end-to-end verification.

Features

- Chrome extension for capturing and pruning page DOM trees.
- Node.js API for webhook intake and event processing.
- Event ID-based idempotency support.
- Authenticated dashboard.
- Snapshot history and access controls.
- Retry handling for supported processing failures.
- Automated backend tests.
- Optional PostgreSQL setup using Docker Compose.

Tech Stack

- JavaScript
- Node.js and npm
- Chrome Extension APIs
- HTTP APIs
- PostgreSQL
- Docker Compose
- Node.js built-in test runner

Prerequisites

- Node.js and npm
- Google Chrome for extension testing
- Docker Desktop for the optional PostgreSQL Compose setup

Local Setup

Clone the repository and open the project folder in PowerShell.

Install dependencies:

npm.cmd install

Run tests:

npm.cmd test

Start the API and dashboard on port 3000:

$env:PORT = "3000"
npm.cmd start

Open http://localhost:3000.

To use the API URL configured in the Chrome extension, start the server on port 3001 instead.

Load the "extension/" directory as an unpacked extension in Chrome and reload the target page before testing capture behavior.

Environment Variables and Security

The application uses server-side secrets for protected operations.

Variable| Purpose
"PORT"| Server listening port
"DASHBOARD_ACCESS_TOKEN"| Dashboard authentication
"WEBHOOK_SECRET"| Webhook authentication
"SNAPSHOT_READ_SECRET"| Snapshot-history access
"POSTGRES_PASSWORD"| PostgreSQL password for the Compose setup

Generate a dashboard access token in PowerShell:

$env:DASHBOARD_ACCESS_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
npm.cmd start

Configure the webhook and snapshot secrets separately when testing their respective endpoints.

Never commit actual secrets, passwords, or private credentials to the repository. Do not expose server-only secrets in Chrome extension code.

See "BACKEND.md" for API examples, authentication requirements, retry behavior, and troubleshooting.

PostgreSQL with Docker Compose

For local PostgreSQL development, install and start Docker Desktop.

Set the required environment variables in PowerShell:

$env:POSTGRES_PASSWORD = node -p "require('node:crypto').randomBytes(32).toString('hex')"
$env:WEBHOOK_SECRET = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:SNAPSHOT_READ_SECRET = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
$env:DASHBOARD_ACCESS_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('base64url')"

Start the stack:

docker compose up --build

The Compose configuration publishes the API on the host loopback interface. PostgreSQL initialization and runtime setup are described in "BACKEND.md" and "db/init.sql".

Existing database volumes may require explicit migrations when the schema changes.

Testing

Run the automated test suite:

npm.cmd test

Additional test scripts for webhook handling, processing, and retry behavior are defined in "package.json".

Automated tests do not independently verify Chrome extension behavior, Docker, PostgreSQL, or every production deployment scenario.

Current Scope and Limitations

- Webhook processing uses a deterministic local mock adapter. A real downstream integration requires a specified target system, authentication method, and delivery/failure contract.
- Dashboard login has been verified on the deployed service.
- Event ingestion and snapshot visibility on the deployed dashboard are still being verified.
- Production database configuration and durable storage have not yet been confirmed.
- A demo video link should be added when available.

Repository Structure

- "extension/" — Chrome extension
- "test/" — Automated tests
- "db/" — Database initialization
- "index.js" — Node.js application entry point
- "BACKEND.md" — API documentation and troubleshooting
- "compose.yaml" — Docker Compose configuration
- "Dockerfile" — Container build configuration
- "package.json" — Dependencies and scripts

License

No license has been specified in this README. Add the applicable license if one has been selected.
