# AgentVoice: storage, diff sync and message delivery

November 15, 2026. Proposed design, not deployed. Supersedes the earlier outline.
Only the fake-data MCP probe exists. Its read-only tool is confirmed working in
iPhone Live voice by the owner. Authenticated and mutating tools remain untested.

## Verified against the installed V2 contract

- `opencode-dev debug paths db` resolves the active SQLite DB to
  `~/.local/share/opencode-v2/data/opencode/history-v1.db`. The filename does not
  make it V1. V2 uses SQLite WAL, session/message projections and durable events.
- The V2 source has `session_v2`, `session_message`, newer `session_part`,
  `event_sequence`, `event` and `session_inbox`. New-message sequence is not the
  change cursor: streaming mutates existing messages. A timestamp-only sync is
  insufficient. Agent View already accounts for this in its history index.
- The running OpenAPI exposes a durable per-session event stream:
  `GET /api/experimental/session/{id}/log?after=N&follow=true`. The cursor is
  exclusive. The global `/api/event` stream is explicitly volatile, so it can
  wake a sync worker but cannot be the durable cursor.
- The running prompt endpoint accepts caller-supplied `id`, `text`, `metadata`,
  `delivery` and `resume`. It returns a durable OpenCode inbox admission.
- V2 inbox reconciliation finds an existing ID in either pending work or delivered
  messages. First admission wins for the same session/type. It does not compare
  retried text: our bridge must reject a changed payload under the same ID.
- `resume:false` suppresses waking the loop. It does NOT promise that an already
  running agent cannot consume that input. It is not a safe append-only note API.
- Agent View voice sends through `VoiceHost.send -> ControlHub.reply`. Reuse the
  provider operations, not a second coding environment.

Only source, metadata contracts and the local OpenAPI were inspected. No real
conversation bodies were read/uploaded, messages sent, or live DB settings changed.

## Architecture and trust boundaries

| Flow | Local source | Cloud storage | ChatGPT can read? |
| --- | --- | --- | --- |
| Disaster recovery | Entire SQLite DB, private rows included | Encrypted restic repository in private R2 | No |
| Offline conversation | Explicitly approved sessions/context | Owner-scoped Neon Postgres | Yes, approved content |
| Remote messages | User-authorized messages | Neon outbox, then local OpenCode inbox | Within the approved integration |

TypeScript on Fly, Neon and R2 follow the existing Understand/VoiceCode stack.
Use separate resources and secrets from their production apps. Reuse the Google
login approach, but implement the MCP-facing OAuth code/PKCE, discovery and scoped
token flow. No Auth0 or Better Auth dependency is required. Do not copy fallback
secrets, auth-disabled defaults or year-long application tokens.

The cloud never decrypts/mounts the full SQLite backup. The Mac remains the only
development executor. All Mac connections are outbound. Nothing listens publicly
on the Mac, and its OpenCode API credential never enters the cloud.

## Shared Mac service

Extract a SessionRepository and SubmitMessage operation from Agent View's
provider database/control adapters. The dashboard and a per-user launch agent
use that shared code. This connector runs without an open dashboard window.
Call-local focus, temporary voice handles, watches and drafts stay per client.

Read projections using short read-only SQLite transactions, as Agent View already
does; source writes always use the OpenCode API. Pin/feature-detect the installed
schema and contract. Do not assume website docs match a running older executable.
The submit operation accepts a stable ID and delivery policy; the dashboard can
retain its current behavior while remote delivery queues for the next turn.

## A. Incremental approved-session sync

1. Enable a specific session locally. Children/forks/other chats/files do not
   inherit approval. No unapproved titles, paths or snippets reach the server.
2. Capture its baseline projection and durable event high-watermark H in one short
   source read transaction. Verify event/projection commits are atomic for the
   installed build. Upload staged baseline chunks; expose them only after commit.
3. Cloud commits rows and H together, then ACKs. Local cursor advances only after
   ACK. Replay the durable session log after H to capture concurrent changes.
4. Events mark dirty message/part IDs. Coalesce streaming edits for about five
   seconds and flush on completed turns. Read affected current rows, not the full
   history. Hash rows to omit unchanged values; send upserts and explicit tombstones.
5. Batch key: device, database epoch, session, sharing epoch, from/through sequence
   and payload hash. Cloud rejects out-of-order/conflicting batches and applies
   rows+cursor atomically. Retried batches return the original receipt.
6. Reconnect from the ACKed cursor. Missing event history, schema changes or a
   replaced/restored DB require a new epoch and baseline of approved sessions
   only. Never silently skip a cursor gap. Include edits, compaction, reverts,
   deletes, imported legacy history and split parts in integration tests.
7. Use a cheap, bounded metadata reconciliation as a safety net, not whole-body
   polling. Each phone read returns revision, sync time and heartbeat age.

Offline means discussing the last synced context, not running the local coding
agent. Unuploaded local changes are unknowable to the cloud. Repository files
are not implicitly backed up or exposed; project context needs its own allowlist.

## B. Incremental encrypted database backup

Preferred pipeline: **Litestream local file replica -> restic -> private R2**.
Existing tools, but this integration is not tested. Prototype on a disposable
actively written DB before attaching to the real source.

- Litestream follows WAL page changes into a local replica: initial baseline plus
  transaction/page-update objects. Do not repeatedly rebuild the full DB each
  time a message changes. It creates shadow data and interacts with checkpoints;
  it is not a zero-impact read-only observer. Measure writer latency and locks.
- Select a completed contiguous restore point H. Build a fixed manifest of the
  finalized baseline/update files needed for H and pin them against retention
  during backup. Verify finalized-file immutability for the chosen version. If
  needed, make a stable local staging set. Never back up a disappearing chain.
- Restic reads that committed set, deduplicates and encrypts data AND snapshot
  metadata **inside the backup process on the Mac**, before TLS upload to R2.
  Use stable source paths/parent matching so unchanged files need not be reread.
  A successful snapshot must include the complete manifest. Only then advance
  last-cloud-backup and release pinned files. Partial/error snapshots are not ACKs.
- Current Litestream v0.5.x does **not** support age client-side encryption.
  Direct Litestream-to-R2 is therefore not this design. R2 server-side encryption
  is not a substitute for keeping the decryption key off the server.
- First backup is full. Periodic baselines, compaction, VACUUM, replacement or
  recovery can still trigger larger local reads/uploads. SQLite changes include
  index pages: a one-word edit is not a one-byte upload. Deduplication saves
  bandwidth but alone does not eliminate source I/O.
- Initial cadence: batch cloud backups about once a minute while dirty. Proposed
  recovery retention: 30 days. Bound local spool (initial target 2 GB or one full
  baseline, whichever is larger). Alert at pressure; never silently discard an
  unuploaded chain, fill the disk through WAL retention, or block the writer to
  preserve backup freshness. Recovery may require a new full baseline and must
  report any lost recovery window. Validate chain-aware retention/pruning first.

### Exactly where encryption and keys live

The original DB and local replica staging remain application-readable plaintext.
Put staging in a user-only directory; verify FileVault protection rather than
claim it is enabled. This does not convert OpenCode to encrypted SQLite.

Generate a random restic repository password on the Mac, store it in a dedicated
Keychain item and a recovery copy in 1Password. Supply it privately to restic in
memory/a pipe, never argv, logs, committed config or cloud secrets. No key is
created during this design task. Local malware on an unlocked Mac can still
steal plaintext or keys.

MCP/Fly has neither backup-bucket credentials nor the repository key. Use separate
backup credentials. Protect retained restore points from deletion independently:
encryption cannot stop a compromised uploader destroying backups. Test actual
R2/restic permissions before promising append-only behavior.

Recovery on a clean machine: recovery key -> restic restore to a scratch replica
-> Litestream restore to a new DB path -> SQLite integrity check -> compatible
OpenCode. Never overwrite a running DB. This covers DB contents, not source-code
repos, Keychain, ignored files or the complete development environment.

## C. Real messages and two durable queues

Yes: “send this to the session” should send a real message that can start an agent
turn, like Agent View voice. “Notes” was too narrow. Do not automatically send
brainstorming or export the whole ChatGPT conversation.

### Cloud outbox

Validate owner and a distinct write grant. A read-only iPhone tool test is NOT
proof of mutating-tool eligibility; test this before rollout and describe tool
behavior honestly. Persist before returning “queued”.

Row fields: operation ID, owner, device, DB epoch, session, sharing epoch,
per-session sequence, text, payload hash, base source revision, mode, expiry,
state, lease owner/expiry, attempts, next retry, OpenCode message ID, receipt.

- Same client operation ID + same body returns the original queue receipt.
  Same ID + different body is a conflict. Sequence assignment is transactional.
- Make the client operation ID explicit in the tool schema/receipt. The client
  must preserve it across retries, or query status before retrying an uncertain
  send. If a model invents a new operation ID, transport deduplication cannot
  prove it is the same intent. Do not promise semantic deduplication, and do not
  suppress genuinely repeated user messages by fuzzy text matching.
- Mac outbound long-poll ~25 seconds, heartbeat ~20 seconds, unavailable after
  ~60 seconds without heartbeat. No inbound port or assumed remote wake.
- Lease only the head unadmitted message per target. Expired leases retry with
  bounded backoff/jitter. Different sessions progress independently.
- Default executing-message TTL: 24 hours. Source revision changed since the
  phone read it? Require reconfirmation before executing the stale instruction.
  Revoked sharing, deleted sessions, wrong DB epoch and expiry are explicit
  failure/review states. Do not recreate/reroute sessions automatically.
- This is not atomic compare-and-send with arbitrary desktop writers. Serialize
  connector work and surface that race; a hard source revision precondition would
  need an OpenCode-side API enhancement, not a claim in the cloud UI.

### Mac admission and crash recovery

Persist the operation-to-OpenCode-message-ID mapping and payload hash locally
BEFORE the first POST. Send through the shared provider operation:

```
POST /api/session/{sessionID}/prompt
{ id: stable_id, text, metadata: { source: "agentvoice", operation_id },
  delivery: "queue", resume: true }
```

OpenCode durably admits the input in `session_inbox`. Its existing runner owns
execution. Queue for the next turn; do not interrupt or bypass permission gates.
Cloud ACK includes the admitted ID. If the Mac crashes after POST but before
ACK, check that same ID in inbox/message history and retry with the SAME ID.
Source reconciliation prevents a second user input. Repeated wake calls and
code side effects are NOT promised exactly-once; verify retry behavior in tests.

States: **queued -> leased -> accepted by OpenCode -> reply observed**.
Branches: needs confirmation, expired, cancelled, failed, uncertain. “Accepted”
does not mean executed/completed. Replies return through ordinary diff sync.
Cloud FIFO advances after admission; local desktop inputs may interleave. Report
the canonical OpenCode order. A DB restore must not replay old executing work.

Non-executing save: keep a draft in the bridge until explicitly sent. Do not call
`resume:false` append-only: busy agents may consume it. A genuinely append-only
context operation would be separate future work.

## Authorization and revocation

Google login identifies the preapproved owner. ChatGPT gets bridge OAuth tokens;
paired Macs get separate revocable credentials; local OpenCode credentials stay
local. Validate audience/issuer/expiry AND live sharing grants on every read,
list, search and write. Scope reads and writes independently.

Revocation stops reads/sync/new deliveries, retires the sharing epoch, cancels
cloud queued messages, purges context and indexes, and rejects late old batches.
Already-returned ChatGPT content cannot be recalled. An already-admitted local
message is not undone: inbox cancellation is best effort while still pending.
Neon backup retention has a stated expiry, separate from immediate live access.

No public signup, chat-body analytics, token logs or payload-rich crash reports.
Readable context is not end-to-end encrypted from Fly/OpenAI. The full encrypted
DB backup is a separate trust boundary, never an MCP data source.

## Build order and acceptance tests

1. Owner auth, pairing, per-session read/write grants. Test missing/expired/
   wrong-owner/wrong-audience/revoked tokens with synthetic data.
2. Shared provider extraction + baseline/diff sync. Test streaming edits,
   compaction/deletes, reconnect gaps, duplicate/out-of-order batches and epochs.
3. Disposable OpenCode session -> iPhone cached read with connector offline.
   Show truthful age. Do not silently enable existing sessions.
4. Test iPhone write eligibility, then queue admission with stable IDs, busy
   sessions, permission waits, stale base revisions, TTL, cancellation, and a
   forced crash after POST/before ACK. No duplicate user messages on retry.
5. Disposable backup prototype: concurrent writes, checkpoint/retention races,
   network loss, disk cap and process kills. Measure read/write/upload bytes and
   source writer p95 latency, not only upload size. Restore on a clean machine,
   check integrity and a private canary. Verify cloud-only access cannot decrypt.
6. Only after those gates, owner selects real shared sessions and enables the
   encrypted full backup. No real uploads are authorized by this planning task.

Track approved-context ACK age and recoverable cloud-backup age separately.
Heartbeat is not proof of successful sync or backup; queue receipt is not proof
of execution. This SVG/plan does not claim any of the proposed services exist.

## Sources checked

- Running local V2 `/openapi.json`; V2 core session/inbox/event/SQLite source.
- Agent View voice host, history index, database/control adapters.
- https://opencode.ai/v2/docs/api
- https://litestream.io/reference/config/#encryption
- https://litestream.io/guides/file/
- https://restic.readthedocs.io/en/stable/040_backup.html
