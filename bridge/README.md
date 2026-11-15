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
| iPhone text | Not tested |
| iPhone Live voice | Not tested |
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
not an assumed workaround. Stop before building session sync until this is settled.

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
Live voice. The device test is the remaining feasibility gate.
