# payload-mcp-publish: notes for agents

A Payload CMS 3 helper for `@payloadcms/plugin-mcp` 3: a reviewed publish lane (`publishDraft`). TypeScript, ESM, pnpm,
vitest, biome, release-please. One public entry, `src/index.ts`. Every document is indexed in [docs/INDEX.md](docs/INDEX.md).

## Layout

- `src/lane.ts`: `mcpPublishLane`, `overrideAuth`, `offByDefault`. `src/tool.ts`: the `publishDraft` handler and gate types.
- `src/diff.ts`: full-text diff and digest. `src/pin.ts`: the `beforeChange` hook. `src/ownerUnpublished.ts`, `src/access.ts`.
- `test/lane.int.spec.ts`: Payload on SQLite, driven through the real `POST /api/mcp` with real API keys. Its header lists
  the mutation table (production line to the test that goes red). `test/fixtures/` is the test site.

## Commands

```sh
pnpm vitest run test/<file>   # scoped tests while you work
make preflight                # the full gate: lint, typecheck, test, build. CI runs it once
```

## Rules that are easy to break

- `typescript` stays on 6.x: `@payloadcms/plugin-mcp` transpiles its tool schemas with `ts.transpileModule`; under 7.x every
  create/update tool silently loses its field arguments.
- The lane's own publish write runs without `req`. With `req` a site's draft-only hook saves it as a draft again.
- A digest is not consent. Never describe it as approval.
- This repository is public: no hostnames, operator paths, account names, tokens or client names in any tracked file.
- First publish needs a token once (the package must exist on npm before trusted publishing can be set); see `release.yml`.
- Commits are Conventional Commits; release-please reads them.
