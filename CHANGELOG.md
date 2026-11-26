# Changelog

## [0.1.1](https://github.com/anatolykoptev/payload-mcp-publish/compare/v0.1.0...v0.1.1) (2026-11-26)


### Miscellaneous Chores

* release 0.1.1 ([c7afba8](https://github.com/anatolykoptev/payload-mcp-publish/commit/c7afba81343b219dca9d757b28cee28e3a40b3bf))

## 0.1.0 (2026-11-26)

First release: `mcpPublishLane` for Payload 3 with `@payloadcms/plugin-mcp` 3. `publishDraft` dry run with a full field diff and a content digest, publish only with the matching digest, the key's own update permission, an in-transaction pin against a save between review and publish, refusal of documents the owner unpublished (while their published version is still in the history), refusal of any other MCP publish path, optional publish gate.
