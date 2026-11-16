# Private mobile bridge

This Worker is separate from the public synthetic probe. It uses Google owner
login, MCP OAuth with PKCE, a private Neon database and a revocable Mac connector.
The owner is pinned to `wallawitsch@gmail.com`.

## Deployment

```console
npm ci
npx wrangler deploy --config wrangler.private.jsonc
NEON_PROJECT_ID=<dedicated-project> node private/provision.mjs
```

Provisioning applies both SQL schemas. It creates a runtime role without schema
ownership and saves its credential in 1Password. Worker secrets receive the
runtime database URL and the dedicated Google web client from 1Password.
The Google callback is `<issuer>/auth/google/callback`.

The deployed test setup uses the **AgentVoice Free** Neon organization
(`org-purple-unit-21830200`), project `frosty-pond-48075355`, fixed at 0.25 CU.
It is not in the paid Moritz organization. Cloudflare Worker:
`https://agentvoice-private.moritzw.workers.dev`.

## MCP

Add `<issuer>/mcp` to ChatGPT with OAuth. Discovery and dynamic registration are
supported. Registered redirects are limited to ChatGPT's documented callback
paths and this server's integration-test callback. Google login and browser-bound
consent precede every new grant. Scopes are `history:read` and `messages:send`.
Refresh tokens rotate. Replay revokes the token family.

Tools: `list_sessions`, `search_history`, `read_session`, `read_message`,
`send_session_message`, `message_status`, and `cancel_message`.

The instruction queue is separate from mirrored messages. Stable operation IDs
deduplicate cloud writes. Stable OpenCode message IDs reconcile local admission
after a lost response. Changed context requires a fresh read and confirmation.
Native permissions are not bypassed. Queued does not mean executed.

## Free-tier behavior

Idle connector polls use a SQLite Durable Object, not Postgres. Polls wait up to
20 seconds, about 4,320 requests per day for one Mac. The daemon checks source
history every 15 minutes while idle. Mobile use requests five minutes of faster
checks. Neon can suspend between idle syncs.

At 0.25 CU, 100 CU-hours covers 400 active hours per month. Five minutes awake
after each 15-minute idle sync is about 240 active hours per 30 days. Continuous
active use can exceed Free compute. The 1 GB database limit includes indexes and
receipts, not just text. No always-free claim is made without measuring usage.

Expired OAuth rows, receipts and abandoned staging rows are not automatically
purged yet. Monitor storage before sustained use. Do not delete unacknowledged
receipts or staging while a connector can retry them.

## Tests

```console
npm test
node test/e2e/cloud-vm.mjs
```

The second command is an operator harness for the prepared Cua macOS VM. It
requires the disposable `vm_environment.py` service, the test Agent View binary
and the signed-in browser forwarded on port 19949. It uses synthetic sessions
and a deterministic local model. No paid model credential is needed.

Verified against the deployed Worker and Neon: owner Google login, code/PKCE
exchange, actual OpenCode history projection, tool-output canary exclusion,
remote admission and reply sync, retry deduplication, revert/unrevert, forks,
dashboard-independent login-item delivery, offline queueing, refresh rotation and
revocation. Actual authenticated ChatGPT text search and approved send/reply have
also passed. Private iPhone Live voice still requires its own device check.

Backend queries can read copied text. OpenAI sees retrieved content. Logs exclude
request bodies, SQL, credentials and URLs with codes. The source database and
provider credentials remain local. Full encrypted backups and remote wake are
not part of this implementation.
