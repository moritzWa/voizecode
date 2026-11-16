# Verification, November 16, 2026

## Deployed cloud and macOS VM

`cloud-vm.mjs` passed against the private Cloudflare Worker and Neon Free.
The VM ran the real OpenCode V2 binary and the new Agent View connector.
The model was a deterministic local HTTP fixture, not a paid LLM.

Verified: Google owner login and consent, code/PKCE token exchange, source history
upload, full-text search, actual tool-output canary exclusion, remote sends,
same-ID retry deduplication, agent reply sync, native revert/unrevert, native
forks, dashboard-independent login-item sync, stopped-connector queueing,
reconnect delivery, refresh rotation and immediate revocation.

A separate payload fixture uploaded one 741,020-byte visible user message
through the Free Worker without a request failure. This is a payload test, not a
claim about sustained Free-tier CPU or monthly usage.

Neon's control API reported 1,077 compute seconds (about 0.30 CU-hours), 252,391
egress bytes and a 31,768,576-byte branch logical size during this test run.
The endpoint's `suspend_timeout_seconds: 0` means the plan default, not disabled
autosuspend. Neon Free fixes that default at five minutes.

## Actual ChatGPT text client

The owner connected the private **AgentVoice** plugin through real OAuth.
ChatGPT searched for `BRIDGE_E2E_AGENT_REPLY` and quoted a matching result.
It then read a disposable session and requested approval for a mutating send.
After **Allow once**, it queued `CHATGPT_SEND_PROOF_1794805408039`, observed
`accepted`, and read the exact user input and subsequent fixture-model reply.

Test conversation:
`https://chatgpt.com/c/6afa8e75-8894-83ea-b85a-6c89fe0cedde`

This check caught a browser-only issue that the same-origin integration callback
did not: the consent page's form-action CSP blocked its redirect to ChatGPT.
The policy now permits the already-allowlisted ChatGPT callback origin.

## iPhone confirmation and personal-history rollout

The owner confirmed the private iPhone Live check on November 16. The backend
independently recorded its `PhoneTest_20261116_0939` operation queued against the
offline disposable VM. This verifies private write-tool eligibility, not execution
of that particular queued test. The earlier VM harness already proved admission
and reply sync using the same transport.

After confirmation, the personal Mac paired through Google owner consent. Its
initial upload committed 2,608 sessions and 72,252 visible messages (38,307,859
text bytes). Local and cloud counts matched with no unacknowledged batches.
Database size was 116,178,944 bytes at that point. An authenticated read-only
MCP grant listed real history and returned an exact source-message hash match.
No personal chat bodies were logged by the verifier.

The native login item is running with shared V2 service-discovery settings.
Closing the dashboard does not stop it. A first-day Free-tier usage review is
scheduled; this is not a claim of sustained monthly quota compliance.

## Not claimed

- Live voice audio in this VM. A fake-microphone run opened voice mode but did
  not produce a new transcribed turn, so it is not evidence of a voice tool call.
- Sustained monthly quota compliance or wireless remote wake.
- Native permission bypass. The connector does not alter permission rules.

## Full local source audit, without upload

The Rust source reader projected all 2,609 local sessions: 72,221 visible
messages and 38,285,538 UTF-8 text bytes. The largest encoded message was
761,406 bytes, within the 850 KB connector batch budget. No personal text left
the Mac during that pre-rollout audit. It caught an overly small 500K-character
message limit; the
protocol now accepts up to one million characters, still subject to its 1 MB
request-byte limit. The production reader and backend have a matching large-paste
regression test. Long-message pagination also preserves Unicode character offsets.

Local coverage includes inline/split text, legacy-only sessions, source cursor
gap reconciliation, revert resolution, hidden reasoning/tool metadata, crash-safe
batch replay, chunked deltas, rollback, stale-context sends, cancellation, expiry,
uncertain admission and owner/device isolation.
# Real phone workflow repair, November 16, 2026

The initial rollout checks did not prove the user's workflow. The real ChatGPT
conversation exposed missing native status metadata, cursor/offset confusion,
and an instruction that reached `needs_confirmation` instead of OpenCode. The
Mac was asleep; an appended desktop turn later invalidated the old strict cursor
check. A cloud `queued` receipt was not proof of delivery.

Candidate Worker version `756a6d27-a784-4611-b623-600567980706` passed a new
deployed-cloud/macOS-Cua regression with real OpenCode and a local fixture model:

- A phone send based on an older mirrored read survived an appended desktop turn.
  Native admission, a later reply and a completed native state matched its input ID.
- Retrying the operation left exactly one native user input.
- A native revert still stopped admission with `needs_confirmation`.
- One `list_sessions(status="needs_you")` call found an actual native approval.
- The personal primary source stayed unchanged throughout the fixture run.

The reconnect test also exposed stale registration handling after a VM reboot.
The candidate connector now verifies and adopts the live replacement service.
Backend tests: 30 passed. Agent View library tests: 948 passed, 7 ignored.

The authenticated ChatGPT text client then made one latest-message read with
`limit: 3` and no offset scanning. It sent one new instruction to a separate
synthetic personal-Mac session, checked the actual `accepted` receipt, and read
`MOBILE_REPAIR_NATIVE_OK_20261116` after that operation's input. It did not reuse
the old fixture reply or claim completion from admission alone. The old personal
daemon had no native-state snapshot, so `completion_confirmed` correctly stayed
false even after the new reply appeared. A follow-up adds an explicit `page_kind`
field because the client over-explained the former `no_newer_messages: false`.

These are transport and native-state checks, not a new iPhone Live verification.
The phone's original implementation operation was not resent or marked delivered.
