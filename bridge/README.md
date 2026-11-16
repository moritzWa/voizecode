# AgentVoice MCP feasibility probe

Test ChatGPT as the phone voice client before building another app.

## Deployed probe

- MCP: `https://agentvoice-mcp-probe.moritzw.workers.dev/mcp`
- Health: `https://agentvoice-mcp-probe.moritzw.workers.dev/health`
- ChatGPT plugin: **AgentVoice Probe**, connected to `wallawitsch@gmail.com`.
- Tool: `get_session_status`, read-only, synthetic data only.

The endpoint is deliberately public and unauthenticated. It has no OpenCode
connection, session data, secrets, storage, or write tools. Do not add real data
to this endpoint. Private session access needs authentication first.

Each call returns server time and a fresh proof code. A repeated earlier answer
does not pass the test. MCP requests use Streamable HTTP and the official SDK.

## Run

```sh
cd bridge
npm ci
npm test
npm run deploy
npm run check:remote
```

The remote check initializes a real MCP client, discovers the tool and calls it
twice to check that results are fresh. Run full suites through the local heavy-job
queue where required. This directory is independent of the existing relay.

## Results

Tested November 14, 2026 (New York; November 15 UTC).

| Surface | Result |
| --- | --- |
| Local worker tests | 5 passed |
| Deployed endpoint, official MCP client | Passed initialization, tool discovery and two distinct proof codes |
| ChatGPT web custom-server creation | Passed; installed and connected without a paid-plan change or public submission |
| ChatGPT web text | Returned server time `2026-11-15T03:34:17.773Z` and proof `bd01877b-f3a2-4073-9678-fa0bc1d72138` |
| ChatGPT browser voice in macOS VM | Passed spoken request, transcription and a fresh MCP tool call. Server time `2026-11-15T05:23:24.315Z`, proof prefix `e35f3701` |
| ChatGPT native macOS app | Sign-in succeeded, but version `26.1111.21308` stalled on its startup screen before voice was accessible. Not a voice/tool compatibility result |
| iPhone text | Not tested |
| iPhone Live voice | Owner-confirmed pass; fresh proof matched (first/last characters checked) |
| Mutating tools | Not implemented or tested |

Web test chat: <https://chatgpt.com/c/6af92823-f4e0-83ea-b32d-9b36ca342bc6>.

### iPhone test

1. Open ChatGPT with the same account. Start a new text chat and look for
   **AgentVoice Probe** in the plugin picker or `@` menu.
2. Ask: “Use AgentVoice Probe to check the connection. Give me the server time
   and full proof code.” Record whether it appears, calls the tool, or errors.
3. Select **Live** under Voice settings if offered. Start a voice conversation
   and make the same request. Record this separately from the text result.
4. If the plugin is missing, open the existing web test chat on iPhone and ask
   Live to call it again. Repeating the old proof code is not success.

Do not infer iPhone support from the web result. Do not infer custom-app support
from support for public directory apps. Publication is a separate experiment,
not an assumed workaround. The owner has now confirmed the read-only Live voice
path on iPhone. Authenticated access and mutating tools remain separate gates.

## Documentation checked

- [ChatGPT Voice](https://help.openai.com/en/articles/8400625-voice-mode-faq)
  says Live can use plugins and connected apps available to the account. It also
  describes on-screen action approvals on both web and mobile.
- [Custom MCP connections](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
  still says custom connections are web-only. It lists Pro read/fetch access and
  Business/Enterprise/Edu full MCP support. The actual web account allowed this probe.
- [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
  documents public HTTPS Streamable HTTP and the Plugins custom-server workflow.

These pages do not establish that a privately added server is callable in iPhone
Live voice. The owner has since confirmed this read-only device test. Authenticated
access and mutating tools remain separate gates. See [the detailed sync design](SYNC-DESIGN.md)
and [visual architecture](architecture.svg).

## Automated voice experiment (November 15 UTC)

Used `local:mac-for-desktop-testing`, with speaker output muted throughout.
Installed the official desktop app and BlackHole 2ch for virtual microphone
loopback. The native app did not progress past startup, including after relaunch.
The browser experiment is separate evidence, not a substitute native-app pass.

The saved ElevenLabs credential returned HTTP 401. Used macOS `say` instead,
routed directly to BlackHole. No sound was played on the host. A browser input
measurement confirmed a nonzero signal on the virtual microphone (peak 0.738).

Spoken request:

> Use Agent Voice Probe to check the connection now. Call its get session status
> tool. Tell me the new server time and the first eight characters of the proof
> code. Do not repeat the previous result.

ChatGPT transcribed that request, displayed “Retrieved synthetic session status”,
then returned the fresh server time and proof prefix recorded above. The voice
response also read the result aloud. The browser used the `/realtime/wm` route.
This proves a real browser voice-to-MCP path, not dictation followed by a manually
sent text prompt. The voice call was ended after the result.

No private sessions were synced by the probe. No real OpenCode API, database, or
credentials were connected to it. macOS native-app voice remains unproven. The owner later
confirmed the iPhone read-only Live voice path separately.

## Text-only sync implementation

The separate [private bridge](private/README.md) is deployed on Workers/Neon Free.
It includes Google/MCP OAuth, device pairing, bounded history tools, queued
messages and the Agent View login daemon. It never shares private code or data
with the public probe. Scope is all dates and sessions, visible user/assistant
text only. The owner confirmed private iPhone Live and enabled personal-history
sync. See [verification evidence](test/e2e/VERIFIED.md). Full database backups and
wireless wake are separate projects; sustained Free-tier quotas remain monitored.
