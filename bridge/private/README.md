# Private bridge moved to Agent View

The private Worker, OAuth, outbox, SQL and provisioning tool now live in
[agentview/bridge/private](https://github.com/moritzWa/agentview/tree/main/bridge/private).
Use [deployment setup](https://github.com/moritzWa/agentview/blob/main/bridge/SETUP.md)
and [Mac/ChatGPT setup](https://github.com/moritzWa/agentview/blob/main/docs/mobile-bridge.md).

This source relocation does not deploy or change the existing Worker at
`https://agentvoice-private.moritzw.workers.dev`, OAuth identity, Neon database,
secrets or installed connector. Do not provision or pair again for the move.

The public synthetic probe stays here. Maintenance remains tracked in
[issue #18 (credential renewal, retention and oversized future messages)](https://github.com/moritzWa/voizecode/issues/18).
