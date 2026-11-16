# Text-only sync core

Implemented locally. **Not deployed, not connected to OpenCode, and not reachable
through the public MCP probe.** This is the protocol/storage first slice, not the
complete Google/OAuth/Agent View integration.

## Scope

All sessions, all dates: user text and visible assistant text only. Tool calls,
tool results, hidden reasoning, attachments, paths, model-native payloads and
arbitrary source metadata are never serialized by the projection adapter. Visible
text itself may still contain secrets or quoted tool output; it is not a redactor.

Local sizing pass: about 38 MB visible text, 49 MB with compact
message metadata for 72,056 messages. This measured the installed inline-content
V2 projection only, not inherited fork rendering, legacy-only sessions or actual
Postgres index/storage size. It is an estimate, not a proof of full-history coverage.

The OpenCode DB is authoritative. Postgres receives only connector-projected
history. Phone instructions belong in a separate future outbox, never optimistic
inserts into the mirrored conversation. Full-DB recovery backups are deferred
and out of scope. Prefer Workers Free + Neon Free, subject to CPU/quota tests.

## Files and guarantees

- `projection.mjs`: explicit field allowlist. User `text` and assistant content
  tagged `text` only. Known tool/reasoning parts are ignored. Unknown source part
  types, malformed data or a missing inline-content array fail closed instead of
  guessing. Empty projections return null: the eventual change adapter must emit
  a delete if a previously visible source message becomes empty/non-text.
- `schema.sql` + `store.mjs`: owner/device/database-epoch scoped Postgres rows,
  opaque hashed scoped credentials, staged initial baseline, delta application,
  duplicate receipts, cursor validation and transactional rollback. Separate
  read/sync credentials are required, checked for expiry and revocation.
- `http.mjs`: authenticated, no-store request handler with a 1 MB body limit.
  No public provisioning, signup, pairing or login endpoint. No insecure local
  auth bypass. No SQL/body/token error logging. The handler requires an injected
  store; absent configuration fails closed. Never attach it to `worker.mjs`.
- `client.mjs`: sends exactly the persisted pending batch over HTTPS, disallows
  redirects, verifies the receipt, and advances local state only after a matching
  ACK. No pending batch means no request and no Neon wake-up from history sync.
- `journal.mjs`: Node 24 local integration harness, not the production Mac daemon.
  Durable pending batch and receipt in a separate user-only SQLite file, bound to
  one source identity. Refuses unrelated SQLite files. The real Agent View daemon
  must use its shared Rust adapters rather than a second JavaScript source reader.

## Protocol

Every batch is versioned and belongs to ONE session. The authenticated credential,
not request JSON, supplies owner/device/database epoch. Source IDs are preserved.
Message `order` is source message order, not the durable event cursor.

Initial baseline: capture a consistent source snapshot and event high-watermark,
then upload chunks with one `upload_id`, identical state/high-watermark and
monotonically increasing `chunk`. Every chunk has a distinct stable `batch_id`.
Retry a chunk with the same body/ID. Partial baselines remain invisible. The final
chunk atomically exposes all staged messages and the captured cursor. Later source
events replay after that cursor. No rebaseline-over-live-generation is implemented:
cursor loss or source replacement must stop until explicit generation recovery is
built, not overwrite live history opportunistically. Interrupted baselines need
their retained local snapshot to continue; abandon/restart cleanup is not built.

Deltas: send projected changed rows, deleted IDs and current session visibility
state with `from` equal to the acknowledged cursor. `through` must advance it.
The server applies rows/state/cursor and stores the receipt in ONE transaction.
An identical repeated batch ID returns the original receipt; different contents
under that ID conflict. Gaps and stale/out-of-order batches fail. The local
journal retains the exact batch until the server ACK is saved durably.

`session.visible_before` is an EXCLUSIVE source message-order boundary. The local
adapter must resolve OpenCode's staged revert message ID using the installed
source's actual semantics. It must not treat message IDs as ordinal numbers.
Reads and literal per-session searches both filter that boundary. Clearing it
restores visibility of retained rows. Committed source deletion emits tombstones.
Already-returned ChatGPT text cannot be recalled by reverting locally.

Session reads return a maximum of 100 messages and support source-order pagination
and literal substring search. This is NOT a finished global full-text index or
MCP tool suite. Payload/context budgets and broader search are rollout work.

## Testing

Run `npm test` from `bridge` through the normal heavy-job queue. All test data is
synthetic. PGlite runs actual PostgreSQL SQL locally; it does not replace Neon
deployment, connection/concurrency, quota or security validation.

Tests exercise mixed text/tool projection, unknown schemas, chunk visibility,
same-ID edits, deletion, staged revert/unrevert, fork/session isolation, wrong
owner/device/epoch, expiry/revocation/audience, SQL rollback, lost server ACK,
failed local checkpoint, journal reopen, file permissions, unsafe source-file
refusal, HTTP size/validation limits, and no idle history requests. Existing probe
tests prove the public tool surface still exposes synthetic data only.

## Gates still required before real history upload

1. Google owner authentication, MCP OAuth code/PKCE flow and device pairing with
   short-lived/revocable credentials. Opaque test credentials are not a substitute.
2. A deployed private Workers/Neon adapter and migrations, rate limits, bounded
   query/context cost, least-privilege DB roles and full owner isolation tests.
   No cloud database was provisioned by this change.
3. Shared Agent View Rust source adapter: consistent snapshot + watermark,
   incremental event mapping, inherited forks, imported legacy history, compaction,
   revert boundary resolution, split-part feature detection, deletions and cursor
   gap/restore handling. Do not silently claim the simple projector covers these.
4. Login launch-agent lifecycle, reconnect/backoff and baseline recovery. History
   sync must not wake Neon while idle. Message polling needs a separate design
   that does not keep querying Neon on every idle poll; do not solve that with an
   unreliable per-Worker in-memory queue.
5. iPhone authenticated read test, then separate message-outbox/write eligibility,
   expiry, duplicate admission and permission-gate tests. The text-sync receipts
   implemented here are NOT receipts for coding-agent execution.
6. Synthetic leak canaries and malicious-history prompt-injection tests, runtime
   CPU/storage/compute measurements and owner-approved real-data enablement.

Remote wake is a separate best-effort enhancement: this Mac reports wireless
wake support and enables network wake on AC, but no tested LAN relay exists.
Neither launchd nor cloud polling can wake a disconnected Mac by itself.
