# Bridge design after the client feasibility gate

**Detailed replacement:** [SYNC-DESIGN.md](SYNC-DESIGN.md) resolves incremental
storage, local encryption and real message delivery. [architecture.svg](architecture.svg)
is the visual map. The owner has confirmed the read-only iPhone Live voice probe.

This is a proposal, not implemented session sync. The harmless MCP probe is the
only deployed part. Keep VoiceCode's existing relay and clients unchanged for now.

## Stack

Follow Understand's server stack: TypeScript on Fly.io, Neon Postgres for state.
Use the existing R2 pattern from VoiceCode only for large context blobs if needed.
Cronus also uses Fly, but its Mongo database offers no clear advantage for this
ordered delivery queue. Provision separate resources, not tables in another app's
production database. The Cloudflare probe does not commit the full service to D1.

The cloud owns authenticated session reads and durable note delivery. The Mac
initiates outbound HTTPS connections. No public OpenCode port, copied OpenCode
credentials, or second coding environment.

## Store context, not a live copy of opencode.db

Keep OpenCode authoritative on the Mac. Export through its authenticated API,
not by uploading the live SQLite file or writing directly to its tables.

Store a scoped, versioned read model:

- Machines: owner, device ID, last heartbeat, last successful sync.
- Sessions: stable provider/session ID, project, title, timestamps and revision.
- Messages: source message/part IDs, text, source revision and ordering.
- Context: selected project instructions and bounded snapshots with capture time.
- Outbox: owner, target, client request ID, sequence, payload, kind and status.

Share nothing by default. OpenCode includes highly private personal chats, not
just coding sessions. Require explicit per-session opt-in on the Mac before any
upload, including titles, snippets, search results and project paths. “Recent” is
not permission to share. Unapproved sessions must be absent from every remote
list, search, read, export and context endpoint. Enforce that scope in code and
test cross-session access; do not rely on model prompts or secret-looking IDs.

For approved conversations, do not upload every repository file, tool output,
environment variable or credential. Strip known secrets, skip private file types
and keep a deliberate context allowlist. Conversation text can itself contain
secrets, so authentication and retention/deletion controls precede real uploads.

Use stable IDs for incremental upserts. Reconcile edits, deletions and compacted
history, not just new timestamps. Show snapshot age on every offline read. A
cached answer must not pretend it describes the current checkout.

## Sleep and wake

Do not make remote wake an MVP dependency. macOS does not offer a reliable generic
internet wake mechanism for a sleeping, lid-closed laptop. Wake-on-LAN depends on
hardware, network, power state and often an always-on peer on the same LAN.
Power Nap is not a guarantee that an arbitrary coding process will run.

The Mac connector runs as a per-user launch agent, syncs while awake and reconnects
after wake. It does not silently keep the laptop awake or alter power settings.
When the heartbeat expires, the cloud reports “Mac offline, context saved at …”.
Reading cached context and queuing notes still work. Code execution waits until
the Mac returns. A later wake experiment is optional and cannot promise execution.

## Share the tools with Agent View

Agent View already has `VoiceHost` and `Tools` in `src/voice/tools.rs`.
`DashboardHost` supplies history and actions through existing discovery, history
index and control code. Reuse those paths rather than creating a second session
reader/sender in TypeScript.

Extract the provider-facing operations into a Rust service/library usable without
an open dashboard. Agent View supplies its dashboard adapter; a small Mac connector
supplies the outbound cloud adapter. MCP and a future mobile app call the same
cloud contracts. Keep the cloud transport thin.

Private reads need owner-bound OAuth and server-side authorization on every
object. Pair each Mac separately, issue scoped revocable credentials, and keep
read, note and execution permissions separate. Do not put credentials in URLs.
Do not log chat bodies, tool payloads, tokens or private session metadata in
analytics, traces or crash reports. Define expiry, revocation and deletion,
including the limits of backup retention, before enabling uploads.

Selected context must be readable by ChatGPT to discuss it. Encryption at rest
does not hide data from a backend that holds the decryption key, nor from OpenAI
after a tool returns it. Do not call that end-to-end encryption. Keep the most
private chats outside this bridge. Do not connect or upload actual conversations
without explicit approval of that data flow.

Do not expose every current voice tool remotely. Start with list/read/context and
explicit note queueing. Interrupt, edit, close and execute are different powers.
Current voice tools also hold call-local focus, short handles, watches and draft
state. Those must remain per conversation; do not share one global `Tools` instance
across clients or turn temporary handles into durable queue targets.

The probe intentionally does not refactor Agent View. That cost is justified only
after choosing a working client path.

## Notes are not execution requests

Use separate operations and permissions for `queue_session_note` and an eventual
`send_session_instruction`. A saved note must not trigger a coding turn. Confirm
the running V2 API's append-without-generation contract in a disposable session
before implementing delivery. A prompt that asks the model “do not execute” is not
an adequate substitute for a non-executing endpoint.

If no suitable append-only API exists, retain the note in the bridge inbox for
explicit desktop import rather than sending it as an executing prompt. No direct
database writes. Notes may inform later authorized turns; they are not a sandbox
for untrusted text.

## Delivery guarantees

Persist before acknowledging “queued”. A unique owner/client-request ID deduplicates
retries. Assign a per-session sequence transactionally; lease one delivery at a
time per target, and retry expired leases with bounded backoff.

Distinguish queued, delivering, delivered, failed and uncertain. “Delivered” means
OpenCode confirmed the append, not that it executed or finished any task. Record
the resulting source message ID. On a crash after append but before ACK, reconcile
a stable operation ID against session history before retrying. Do not claim
exactly-once delivery without a receiver-side idempotency mechanism.

Carry the revision the phone read. If the session changed, a note can retain its
original base revision and show that it is stale. Execution requests require a
fresh read/confirmation rather than silently applying outdated instructions.

## Gate sequence

1. Prove custom MCP on web, iPhone text, and iPhone Live separately.
2. If mobile fails, investigate private/published plugin availability. Do not
   submit publicly or upgrade a subscription merely to assume it will work.
3. If no supported ChatGPT route works, adapt VoiceCode to the same bridge API.
4. Add owner authentication and device pairing, then scoped read-only sync.
5. Test a non-executing note against a disposable OpenCode session.
6. Test connector crash recovery, sleep/wake, offline reads, stale context and
   queue retries before claiming reliable offline operation.
