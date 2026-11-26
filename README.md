# payload-mcp-publish

A reviewed publish lane for [`@payloadcms/plugin-mcp`](https://payloadcms.com/docs/plugins/mcp) 3 on Payload CMS. An agent writes
drafts over MCP; one draft at a time goes live through a `publishDraft` tool, after the owner has seen exactly what would change.
No code change, no deploy.

**Status:** pre-1.0. **Compatibility:** Payload `^3.93.0`, `zod ^3.25.50`, Node `^22.23.5 || ^24.22.3 || >=26.13.1`. ESM only.

## What it guards

- **Two steps.** `publishDraft { collection, id, dryRun: true }` changes nothing. It returns every field that differs from the
  live version, **both values in full** (long text is never cut, array rows are spelled out as `sections[1].heading`, rich text
  is shown as its text and a formatting- or link-only change is flagged), and a `digest`. The publish call passes that digest.
- **The digest binds the draft, the live version it was shown against, the collection and id, and what the site's gate will
  add to the write** (so the dry run takes the same gate arguments as the publish). The server recomputes it and refuses on any
  difference. The update itself re-checks, inside its transaction (`publishPin`), that the draft it builds on is the one
  digested, so a save between the check and the write loses.
- **The key's own scope.** The tool is unticked on every key (the plugin registers custom tools ticked), and a key also needs
  its own `update` box for the collection: the tool never widens a key.
- **A collection allowlist.** Only the collections you list can publish from here.
- **What the owner took down stays down while its published version is in the history.** Payload keeps no record that the owner unpublished a document: a never-published
  and an unpublished document both have a draft live row, and the only evidence is the version history. A document whose live
  row is not published and that has a published version in its history is `retired`: `publishDraft` refuses it, **every MCP
  update of it is refused** (so an agent cannot push the evidence out by saving drafts), and `hideOwnerUnpublishedFromMcp`
  hides it from MCP reads. The owner republishes or edits it in the admin. The history is pruned (`versions.maxPerDoc`), and
  once it has lost the published version the guard cannot tell: **retired documents are best deleted. Delete what you retire.**
- **An MCP write never publishes.** `publishPin` refuses any MCP create or update whose data says `_status: 'published'`,
  whatever the site's draft-only hook does, so the stock update tool is not a second publish path.
- **A half-wired lane refuses.** Each call checks that the collection has drafts and carries `lane.publishPin`, and refuses
  a collection with localized fields on a localized site (the diff and digest would cover one locale of several).
- **Only "not found" is "not found".** Access errors, TOTP refusals and database failures are reported as they are.
- **An optional site gate** (a verification basis the owner must state, a required source, a freshness rule) runs on the dry
  run and again on the publish.

## Use

```sh
pnpm add payload-mcp-publish
```

```ts
// src/plugins/mcp.ts
import { mcpPlugin } from '@payloadcms/plugin-mcp'
import { mcpPublishLane } from 'payload-mcp-publish'

export const lane = mcpPublishLane({
  collections: ['posts', 'pages', 'case-studies'],
  // The public URL of a published document, for the tool's answer. Optional.
  urlFor: (collection, doc) => `https://example.com/${collection === 'posts' ? 'blog' : collection}/${doc.slug}`,
})

export const mcp = mcpPlugin({
  collections: {
    posts: { enabled: { create: true, find: true, update: true } },
    // ...
  },
  // Stashes the key's resolved permissions so the tool can read the key's own `update` boxes.
  // Keep an override you already have: lane.overrideAuth(async (req, getDefault) => { ... })
  overrideAuth: lane.overrideAuth(),
  // publishDraft (and any custom tool of yours that a key must be granted) starts unticked.
  overrideApiKeyCollection: (collection) => lane.offByDefault({ ...collection /* your own access wrap */ }, ['ogCard']),
  mcp: { tools: [lane.tool] },
})
```

On every collection you listed, add the hook:

```ts
hooks: { beforeChange: [lane.publishPin] },
versions: { drafts: true },
```

The lane does not make writes drafts. Keep (or add) a draft-only `beforeOperation` hook for MCP requests, as your site
already has: it must let the lane's own publish through. That is automatic, because the lane's update runs without the MCP
`req`. A site that also lets the stock `update` tool publish with `{ _status: 'published' }` must remove that passthrough:
`publishPin` now refuses it. A draft-only hook must not rewrite reads that pass `overrideAccess: true` (the lane's own
checks read the live row that way, and so do IndexNow-style system reads).

Adding the tool adds a permission column to the API-key table: generate a migration (`payload migrate:create`).

### A site gate

```ts
mcpPublishLane({
  collections: ['posts'],
  gate: {
    parameters: {
      verification: z.object({ basis: z.enum(['own-experience', 'documented-source']), sourceNote: z.string().optional() }).optional(),
    },
    check: ({ args, draft }) => {
      const v = args.verification as { basis: string; sourceNote?: string } | undefined
      if (!v) return // nothing to add; the collection's own publish validation still decides
      if ((draft.verification as { basis?: string } | undefined)?.basis)
        return 'The draft already carries a basis; only the owner changes it.'
      return { data: { verification: v } } // merged into the publishing write
    },
  },
})
```

`check` returns a string to refuse, `{ data }` to merge fields into the publish, or nothing. Its `parameters` become tool
arguments (they may not be named `collection`, `id`, `digest` or `dryRun`). The data is printed in full in the dry run, may
only fill fields the draft leaves empty, and can never set `_status` or a system field.

### Hide retired documents from MCP reads

```ts
import { hideOwnerUnpublishedFromMcp } from 'payload-mcp-publish'
access: {
  read: hideOwnerUnpublishedFromMcp('services', yourReadAccess)
}
```

## Owner approval in Claude Code

The digest proves the draft is the one that was shown. It is not consent. Claude Code can ask the owner before each
`publishDraft` call; there are two ways to set that up. Pick one (the server name is the one you gave the MCP server).

**Per call: an `ask` rule.** Every `publishDraft` call prompts the owner. In `~/.claude/settings.json`:

```json
"permissions": { "ask": ["mcp__<server>__publishDraft"] }
```

Without either, a key with the box ticked publishes unasked as soon as an agent has run a dry run. Keep one of the two.

**Once per session: a grant.** The owner approves publishing once, by typing a phrase in the chat, and the calls that follow in
that session run without a prompt. The package ships the Claude Code side:

```sh
npx payload-mcp-publish claude-hook install                       # grant: publish-ok, allow publishing; revoke: publish-stop, stop publishing
npx payload-mcp-publish claude-hook install --grant "go live" --revoke "stop" --dry-run   # your own phrases; --dry-run prints the diff only
npx payload-mcp-publish claude-hook uninstall
```

- **How it works.** A `UserPromptSubmit` hook looks at what the human typed. A prompt containing a grant phrase (case-insensitive,
  any language) writes a grant file for that `session_id`; a revoke phrase deletes it. Only a prompt the human typed reaches that
  event, so the agent cannot grant itself. A `PreToolUse` hook on `mcp__<server>__publishDraft` answers `allow` when the session has
  a grant younger than 24 hours, and `ask` otherwise, with a reason that names the grant phrase. A missing or malformed
  `session_id` always asks. The hook never trusts a malformed id: it is not cleaned up into a valid one.
- **What install changes** in `~/.claude/settings.json` (a timestamped backup first; running it again changes nothing; every other
  key and hook stays as it was): it registers the two hooks, adds `deny` rules `Write(<grant dir>/**)` and `Edit(<grant dir>/**)`,
  and removes the `permissions.ask` entries for `publishDraft`. It prints each change, and the removed rules so you can put them
  back. `uninstall` reverses what install added; the removed `ask` rules are printed, not restored. `--settings <path>` targets
  another file (the hook is copied to a `hooks/` folder next to it). The hook, its config
  (`payload-mcp-publish-grant.config.json`: `grantPhrases`, `revokePhrases`, `maxAgeSeconds`, `grantDir`) and the grants live in
  `~/.claude/hooks` and `~/.claude/state/publish-grants`.
- **Why the `ask` rules must go.** Claude Code evaluates `deny`, then `ask`, then `allow`, and a hook's `allow` never overrides an
  `ask` rule. While an `ask` rule for `publishDraft` exists, the prompt always appears and a grant cannot take effect. An `ask`
  rule that covers a whole server (`mcp__<server>`) has the same effect: install warns about it and leaves it alone.
- **Failure behaviour.** The `PreToolUse` command ends in `|| exit 2`: if the hook crashes or `node` is missing, the call is
  blocked. The `UserPromptSubmit` command ends in `|| exit 0`: a crash never blocks the owner's prompt, it only means no grant.

Security notes:

- The grant covers `publishDraft` on **every** site (every MCP server) in that session, not one collection or document.
- The dry run, the digest and showing the owner the diff still apply: the grant removes the prompt, not the review. Tell the agent
  to show the owner the dry-run diff before it publishes.
- The `deny` rules cover Claude's `Write` and `Edit` tools only. A shell command (`Bash`) could still write the grant directory;
  restrict `Bash` in your permissions if that matters.
- A phrase is matched as a substring of the prompt, so a prompt that merely contains one (a pasted page, "do not allow publishing")
  grants. Choose phrases that do not appear in ordinary text.
- Publish-capable API keys stay the real boundary: the tool is unticked on every key and a key needs its own `update` box.

## Not covered

- The dry run shows the ids of uploads and relationships, not what they point at: a swapped image shows as a changed id.
  The owner opens it in the admin if the picture matters.
- Writes are not made drafts here (your draft-only hook does that), and the admin's document lock is not touched.
- A save that commits after the update has read its base and before it commits is the one window read-committed Postgres
  leaves; approving one document at a time makes it theoretical.
- Payload 4's plugin API is different; this package takes `mcp.tools` of plugin 3.

## Development

```sh
pnpm install
pnpm vitest run test/<file>   # scoped tests
make preflight                # lint, typecheck, test, build
```

The integration suite runs Payload on SQLite through the real `POST /api/mcp` route. `typescript` stays on 6.x: plugin-mcp
transpiles its tool schemas with it, and 7.x silently empties every create/update tool's fields.

Apache-2.0.
