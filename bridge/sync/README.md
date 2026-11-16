# Sync core moved to Agent View

Implementation, schemas, protocol documentation and tests now live in
[agentview/bridge/sync](https://github.com/moritzWa/agentview/tree/main/bridge/sync).
The production Rust connector remains in Agent View. The public synthetic probe
in this repository does not import or expose the private sync core.
