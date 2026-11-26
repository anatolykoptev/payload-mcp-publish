// @vitest-environment node
import crypto from 'node:crypto'
import { rmSync } from 'node:fs'
import { REST_POST } from '@payloadcms/next/routes'
import { getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publishPin } from '../src/pin.js'
import { makePublishDraft } from '../src/tool.js'
import makeConfig from './fixtures/config.js'

/**
 * The publish lane, driven through Payload's real REST handler with real API keys (`POST /api/mcp`),
 * because every failure here is silent in production: a publish nobody reviewed looks like a working
 * integration.
 *
 * Mutations (each reverted), as FILE:LINE edits, and the tests that go RED:
 * - src/tool.ts the `o.collections.includes` check: "refuses a collection outside the lane" (the direct-handler case;
 *   the zod enum in `publishDraftParameters` is the MCP-level wall).
 * - src/tool.ts the `mcpAccess` update-box check removed: "a key with the publish box but no update box is refused".
 * - src/lane.ts `overrideAuth` without `req.context.mcpAccess = resolved`: the same test, and every publish case
 *   (the stash is what proves the key's own boxes).
 * - src/tool.ts the `_status === 'published'` check: "refuses when there is no pending draft".
 * - src/tool.ts the `digest !== current` comparison: "refuses a digest that is not the draft the owner saw".
 * - src/diff.ts `contentDigest` ignoring `live`: "the digest binds the live version it was shown against".
 * - src/tool.ts `...as` -> `req` in the update (the site's draft-only hook re-drafts it): every publish case.
 * - src/pin.ts the `pin` comparison: "the update itself refuses a draft that moved after the check".
 * - src/pin.ts the MCP-update guard: "an MCP update of a document the owner took down is refused" and "the
 *   owner-unpublished guard survives a pruned version history" (the version history is pruned).
 * - src/tool.ts the `standing === .retired.` refusal: "is not republished from here".
 * - src/lane.ts `'publishDraft'` out of the off-by-default names: "a key without the box ticked has no publishDraft".
 * - src/tool.ts the catch made a catch-all (`return null` for every error): "only a missing document is not found".
 * - src/diff.ts `diffSummary` cutting text at 400 characters, or counting array rows: the "full text" cases.
 * - src/diff.ts the "identical" branch: "a change only in formatting or links is still shown"; `PLAIN` listing `block`/`upload`:
 *   "shows what a block node carries".
 * - src/wiring.ts the `publishPin` check, the `drafts` check, the localization check: "refuses a listed collection that is not wired",
 *   the two fake-payload cases.
 * - src/pin.ts the `_status === 'published'` refusal: "an MCP write cannot publish, with or without a draft-only hook".
 * - src/tool.ts `context: { publishPin }` removed from the update: "a save between the tool's read and its write loses".
 * - src/tool.ts gate data left out of the digest, or the collision check: "the digest binds what the gate adds", "a gate cannot overwrite
 *   what the owner reviewed".
 * - src/lane.ts `overrideAuth` stashing `getDefault()`'s value instead of what `inner` returned: (unit) "stashes what the site's override
 *   returned".
 * - src/tool.ts the gate's `check` not called (or its `data` not merged): the gate cases.
 * - src/access.ts `hideOwnerUnpublishedFromMcp` returning `allowed`: "an MCP find does not list a document the owner took down".
 */
const ORIGIN = 'http://localhost:3000'
const stamp = Date.now().toString(36)
let n = 0
const uniq = (name: string) => {
  n += 1
  return `${name}-${stamp}-${n}`
}

type Rpc = { error?: { message: string }; result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } }
const parseRpc = async (res: Response): Promise<Rpc> => {
  const text = await res.text()
  if (!text) return {}
  const data = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
  return data ? (JSON.parse(data) as Rpc) : {}
}

const text = (t: string, format = 0) => ({ detail: 0, format, mode: 'normal', style: '', text: t, type: 'text', version: 1 })
const para = (...children: unknown[]) => ({
  children,
  direction: 'ltr',
  format: '',
  indent: 0,
  textFormat: 0,
  type: 'paragraph',
  version: 1,
})
const richText = (...blocks: unknown[]) =>
  ({ root: { children: blocks, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } }) as never

const dbName = `lane-${stamp}`

describe('the publish lane over MCP', () => {
  let payload: Payload
  let config: Awaited<ReturnType<typeof makeConfig>>
  let userId: number | string
  const secrets = {
    all: crypto.randomBytes(16).toString('hex'),
    noPublish: crypto.randomBytes(16).toString('hex'),
    publishOnly: crypto.randomBytes(16).toString('hex'),
  }

  const rpc = async (apiKey: string | null, method: string, params?: unknown) => {
    const res = await REST_POST(config)(
      new Request(`${ORIGIN}/api/mcp`, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        method: 'POST',
      }),
      { params: Promise.resolve({ slug: ['mcp'] }) },
    )
    return { body: await parseRpc(res.clone()), res }
  }
  const call = (apiKey: string, name: string, args: Record<string, unknown>) => rpc(apiKey, 'tools/call', { arguments: args, name })
  const textOf = (body: Rpc) => body.result?.content?.[0]?.text ?? ''
  const failed = (body: Rpc) => Boolean(body.error ?? body.result?.isError)
  const publish = (args: Record<string, unknown>, apiKey = secrets.all) => call(apiKey, 'publishDraft', args)
  const status = async (collection: 'posts' | 'case-studies' | 'notes' | 'raw' | 'unwired', id: number | string, draft: boolean) =>
    (await payload.findByID({ collection, depth: 0, draft, id })) as unknown as Record<string, unknown>
  /** What the owner is shown: the dry run's text, and its digest. */
  const dryRun = async (collection: string, id: number | string, apiKey = secrets.all) => {
    const { body } = await publish({ collection, dryRun: true, id }, apiKey)
    return { body, digest: /Digest: ([0-9a-f]{64})/.exec(textOf(body))?.[1] ?? '' }
  }
  const livePost = async (extra: Record<string, unknown> = {}) =>
    payload.create({
      collection: 'posts',
      data: { _status: 'published', slug: uniq('post'), title: 'Live title', ...extra } as never,
      draft: false,
    })
  const liveStudy = async (extra: Record<string, unknown> = {}) =>
    payload.create({
      collection: 'case-studies',
      data: {
        _status: 'published',
        slug: uniq('study'),
        title: 'Live study',
        verification: { basis: 'own-experience' },
        ...extra,
      } as never,
      draft: false,
    })
  /** A live post with a newer draft written over MCP. */
  const pendingPost = async () => {
    const live = await livePost()
    await call(secrets.all, 'updatePosts', { id: live.id, title: 'Reviewed title', blurb: 'Reviewed blurb.' })
    return { id: live.id as number }
  }

  beforeAll(async () => {
    config = await makeConfig(dbName)
    payload = await getPayload({ config })
    const user = await payload.create({
      collection: 'users',
      data: { email: `${uniq('mcp')}@example.test`, password: 'correct-horse-battery-staple' },
    })
    userId = user.id
    const key = (apiKey: string, label: string, permissions: Record<string, unknown>) =>
      payload.create({
        collection: 'payload-mcp-api-keys',
        data: { apiKey, enableAPIKey: true, label, user: userId, ...permissions } as never,
      })
    await key(secrets.all, 'all', {
      caseStudies: { create: true, find: true, update: true },
      notes: { find: true, update: true },
      posts: { create: true, find: true, update: true },
      raw: { create: true, find: true, update: true },
      unwired: { find: true, update: true },
      'payload-mcp-tool': { publishDraft: true },
    })
    // Can write posts but was never given the publish box: a tool a key must be granted.
    await key(secrets.noPublish, 'no publish', { posts: { create: true, find: true, update: true } })
    // The publish box without any update box: the tool must not widen the key.
    await key(secrets.publishOnly, 'publish only', { posts: { find: true }, 'payload-mcp-tool': { publishDraft: true } })
  })

  afterAll(async () => {
    await payload?.destroy?.()
    for (const f of ['', '-shm', '-wal']) rmSync(`test/.tmp/${dbName}.db${f}`, { force: true })
  })

  describe('dry run and publish', () => {
    it('a dry run changes nothing and shows the owner the text, with a digest', async () => {
      const { id } = await pendingPost()
      const { body, digest } = await dryRun('posts', id)
      expect(failed(body), textOf(body)).toBe(false)
      expect(digest).toHaveLength(64)
      expect(textOf(body)).toContain('"Reviewed blurb."')
      expect(textOf(body)).toContain('"Live title" -> "Reviewed title"')
      expect((await status('posts', id, false)).title).toBe('Live title')
    })

    it('publishes exactly the draft the owner saw, field for field, and returns the live URL', async () => {
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      const draft = await status('posts', id, true)
      const { body } = await publish({ collection: 'posts', digest, id })
      expect(failed(body), textOf(body)).toBe(false)
      expect(textOf(body)).toContain(`https://example.test/posts/${String(draft.slug)}`)
      const live = await status('posts', id, false)
      expect(live._status).toBe('published')
      for (const key of Object.keys(draft)) {
        if (['_status', 'createdAt', 'id', 'updatedAt'].includes(key)) continue
        expect(JSON.stringify(live[key] ?? null), key).toBe(JSON.stringify(draft[key] ?? null))
      }
      expect(live.title).toBe('Reviewed title')
    })

    it('publishes a hyphenated collection end to end: a new draft over MCP, dry run, publish, live to the public', async () => {
      const slug = uniq('study-e2e')
      const created = await call(secrets.all, 'createCaseStudies', {
        slug,
        summary: 'Fresh.',
        title: 'Fresh study',
        verification: { basis: 'own-experience' },
      })
      expect(failed(created.body), textOf(created.body)).toBe(false)
      const id = (await payload.find({ collection: 'case-studies', draft: true, where: { slug: { equals: slug } } })).docs[0]?.id as number
      expect((await status('case-studies', id, true))._status).toBe('draft')
      const { body: dry, digest } = await dryRun('case-studies', id)
      expect(textOf(dry)).toContain('Never published')
      const { body } = await publish({ collection: 'case-studies', digest, id })
      expect(failed(body), textOf(body)).toBe(false)
      const anon = await payload.find({ collection: 'case-studies', overrideAccess: false, where: { id: { equals: id } } })
      expect(anon.totalDocs).toBe(1)
    })

    it('refuses a digest that is not the draft the owner saw, and publishes nothing', async () => {
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      await call(secrets.all, 'updatePosts', { id, title: 'Edited after review' })
      const { body } = await publish({ collection: 'posts', digest, id })
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/changed since the dry run/)
      expect(failed((await publish({ collection: 'posts', digest: 'f'.repeat(64), id })).body)).toBe(true)
      expect(failed((await publish({ collection: 'posts', id })).body)).toBe(true)
      expect((await status('posts', id, false)).title).toBe('Live title')
    })

    it('the digest binds the live version it was shown against', async () => {
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      // The live copy moves meanwhile (an admin publish); the draft the agent reviewed ends up identical again.
      await payload.update({ collection: 'posts', data: { _status: 'published', blurb: 'Admin changed the live copy' }, draft: false, id })
      await payload.update({ collection: 'posts', data: { title: 'Reviewed title', blurb: 'Reviewed blurb.' }, draft: true, id })
      const { body } = await publish({ collection: 'posts', digest, id })
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/changed since the dry run/)
    })

    it('the update itself refuses a draft that moved after the check (publishPin, in the transaction)', async () => {
      const { id } = await pendingPost()
      const reviewed = Date.parse(String((await status('posts', id, true)).updatedAt))
      await call(secrets.all, 'updatePosts', { id, title: 'Saved between check and write' })
      await expect(
        payload.update({ collection: 'posts', context: { publishPin: reviewed }, data: { _status: 'published' }, draft: false, id }),
      ).rejects.toThrow(/changed while it was being published/)
      expect((await status('posts', id, false)).title).toBe('Live title')
    })

    it('refuses when there is no pending draft', async () => {
      const live = await livePost()
      const { body } = await publish({ collection: 'posts', dryRun: true, id: live.id })
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/no pending draft/)
    })

    it('only a missing document is "not found"; any other failure is reported as it is', async () => {
      const handler = makePublishDraft({ collections: ['posts'] })
      const req = (error: Error) =>
        ({
          context: { mcpAccess: { posts: { update: true } } },
          payload: {
            collections: { posts: { config: { fields: [], hooks: { beforeChange: [publishPin] }, versions: { drafts: true } } } },
            config: {},
            findByID: async () => Promise.reject(error),
          },
          user: { id: 1 },
        }) as unknown as PayloadRequest
      await expect(handler({ collection: 'posts', dryRun: true, id: 1 }, req(new Error('db down')))).rejects.toThrow('db down')
      const { NotFound } = await import('payload')
      await expect(handler({ collection: 'posts', dryRun: true, id: 1 }, req(new NotFound()))).rejects.toThrow(/not found/)
    })
  })

  describe('what a key may do', () => {
    it('refuses an unauthenticated request with 401', async () => {
      expect((await rpc(null, 'tools/list')).res.status).toBe(401)
    })

    it('refuses a collection outside the lane, and publishes no draft of it', async () => {
      const note = await payload.create({ collection: 'notes', data: { title: 'A note' }, draft: true })
      // The MCP schema refuses it first (a zod enum); the handler's own list is the second wall.
      expect(failed((await publish({ collection: 'notes', digest: 'a'.repeat(64), id: note.id })).body)).toBe(true)
      const direct = makePublishDraft({ collections: ['posts'] })
      const req = { context: { mcpAccess: { notes: { update: true } } }, payload, user: { id: userId } } as unknown as PayloadRequest
      await expect(direct({ collection: 'notes', digest: 'a'.repeat(64), id: note.id }, req)).rejects.toThrow(
        /cannot be published from here/,
      )
      expect((await status('notes', note.id, true))._status).toBe('draft')
    })

    it('a key without the box ticked has no publishDraft', async () => {
      const names = ((await rpc(secrets.noPublish, 'tools/list')).body.result?.tools ?? []).map((t) => t.name)
      expect(names).not.toContain('publishDraft')
      expect(names).toContain('updatePosts')
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      const { body } = await publish({ collection: 'posts', digest, id }, secrets.noPublish)
      expect(failed(body)).toBe(true)
      expect((await status('posts', id, false)).title).toBe('Live title')
    })

    it('a key with the publish box but no update box for the collection is refused', async () => {
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      const { body } = await publish({ collection: 'posts', digest, id }, secrets.publishOnly)
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/cannot update posts/)
      expect(failed((await publish({ collection: 'posts', dryRun: true, id }, secrets.publishOnly)).body)).toBe(true)
      expect((await status('posts', id, false)).title).toBe('Live title')
    })

    it('reads the key box of a hyphenated collection (caseStudies)', async () => {
      const live = await liveStudy()
      await call(secrets.all, 'updateCaseStudies', { id: live.id, title: 'Retitled study' })
      const { body, digest } = await dryRun('case-studies', live.id)
      expect(failed(body), textOf(body)).toBe(false)
      expect(failed((await publish({ collection: 'case-studies', digest, id: live.id })).body)).toBe(false)
      expect((await status('case-studies', live.id, false)).title).toBe('Retitled study')
    })
  })

  describe('what the owner took down', () => {
    const retired = async () => {
      const live = await liveStudy()
      await payload.update({ collection: 'case-studies', data: { _status: 'draft' }, draft: false, id: live.id })
      return live.id as number
    }

    it('is not republished from here, even with a fresh draft on top', async () => {
      const id = await retired()
      expect((await status('case-studies', id, false))._status).toBe('draft')
      // A draft on top, written as the owner would in the admin (an MCP update is refused, see below).
      await payload.update({ collection: 'case-studies', data: { title: 'Retired, edited' }, draft: true, id })
      const { body } = await dryRun('case-studies', id)
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/unpublished by the owner; republish in the admin/)
      expect(failed((await publish({ collection: 'case-studies', digest: 'a'.repeat(64), id })).body)).toBe(true)
      expect((await status('case-studies', id, false))._status).toBe('draft')
    })

    it('an MCP update of a document the owner took down is refused, and adds no version', async () => {
      const id = await retired()
      const before = (await payload.findVersions({ collection: 'case-studies', where: { parent: { equals: id } } })).totalDocs
      const { body } = await call(secrets.all, 'updateCaseStudies', { id, title: 'An agent edits a retired study' })
      // The plugin's update tool reports a hook's refusal as text, so the proof is the text and the untouched history.
      expect(textOf(body) + (body.error?.message ?? '')).toMatch(/unpublished by the owner/)
      expect((await payload.findVersions({ collection: 'case-studies', where: { parent: { equals: id } } })).totalDocs).toBe(before)
    })

    it('the owner-unpublished guard survives a pruned version history (maxPerDoc: 3)', async () => {
      const id = await retired()
      for (let i = 0; i < 6; i += 1) await call(secrets.all, 'updateCaseStudies', { id, title: `Agent save ${i}` })
      const { body } = await dryRun('case-studies', id)
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/unpublished by the owner/)
    })

    it('a document that was never published, and a live one with a draft on top, are still editable over MCP', async () => {
      const created = await payload.create({
        collection: 'case-studies',
        data: { slug: uniq('never'), title: 'Never published' } as never,
        draft: true,
      })
      await call(secrets.all, 'updateCaseStudies', { id: created.id, title: 'Edited' })
      expect((await status('case-studies', created.id, true)).title).toBe('Edited')
      const live = await liveStudy()
      await call(secrets.all, 'updateCaseStudies', { id: live.id, title: 'First draft on live' })
      await call(secrets.all, 'updateCaseStudies', { id: live.id, title: 'Second draft on live' })
      expect((await status('case-studies', live.id, true)).title).toBe('Second draft on live')
    })

    it('an MCP find does not list a document the owner took down, and lists the rest', async () => {
      const id = await retired()
      const mine = await liveStudy()
      const list = textOf((await call(secrets.all, 'findCaseStudies', { limit: 100 })).body)
      expect(list).not.toMatch(new RegExp(`"id":${id},`))
      expect(list).toMatch(new RegExp(`"id":${mine.id},`))
    })
  })

  describe('the dry run shows what the digest binds', () => {
    it('shows the whole text of a changed field, not its first 400 characters', async () => {
      const long = `${'Lead-in sentence. '.repeat(40)}The claim buried deep: it ships in two days.`
      const live = await livePost()
      await call(secrets.all, 'updatePosts', { id: live.id, blurb: long })
      const { body } = await dryRun('posts', live.id)
      expect(textOf(body)).toContain('The claim buried deep: it ships in two days.')
    })

    it('spells out array rows, each leaf with its path', async () => {
      const live = await livePost({ sections: [{ heading: 'One', text: 'Unchanged row.' }] })
      await call(secrets.all, 'updatePosts', {
        id: live.id,
        sections: [
          { heading: 'One', text: 'Unchanged row.' },
          { heading: 'Two', text: 'A new row with a claim: free for life.' },
        ],
      })
      const { body } = await dryRun('posts', live.id)
      const t = textOf(body)
      expect(t).toContain('sections[1].heading: (absent) -> "Two"')
      expect(t).toContain('sections[1].text: (absent) -> "A new row with a claim: free for life."')
      expect(t).not.toMatch(/\d+ item\(s\)/)
    })

    it('shows rich text in full, and a change only in formatting or links is still shown', async () => {
      const live = await livePost({ body: richText(para(text('Plain words.'))) })
      await payload.update({ collection: 'posts', data: { body: richText(para(text('Plain words.', 1))) }, draft: true, id: live.id })
      const { body } = await dryRun('posts', live.id)
      expect(textOf(body)).toMatch(
        /body: formatting or structure changed \(the text, links and embedded content are identical\): "Plain words\."/,
      )
      await payload.update({
        collection: 'posts',
        data: { body: richText(para(text('Plain words, now longer.'))) },
        draft: true,
        id: live.id,
      })
      expect(textOf((await dryRun('posts', live.id)).body)).toContain('"Plain words." -> "Plain words, now longer."')
    })
  })

  describe('rich text that carries more than text', () => {
    const block = (label: string) => ({ fields: { blockType: 'cta', id: 'b1', label }, format: '', type: 'block', version: 2 })

    it('shows what a block node carries, and never calls a changed one identical', async () => {
      const live = await livePost({ body: richText(para(text('Intro.')), block('Old label')) })
      await payload.update({
        collection: 'posts',
        data: { body: richText(para(text('Intro.')), block('Buy now, free for life')) },
        draft: true,
        id: live.id,
      })
      const t = textOf((await dryRun('posts', live.id)).body)
      expect(t).toContain('Buy now, free for life')
      expect(t).toContain('Old label')
      expect(t).not.toMatch(/are identical/)
    })
  })

  describe('wiring and writes over MCP', () => {
    it('refuses a listed collection that is not wired (no publishPin)', async () => {
      const note = await payload.create({ collection: 'unwired', data: { title: 'Unwired' }, draft: true })
      const { body } = await publish({ collection: 'unwired', dryRun: true, id: note.id })
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/not wired/)
    })

    it('refuses a collection without drafts, and a localized one on a localized site', async () => {
      const fake = (config: unknown, root: unknown = {}) =>
        ({
          context: { mcpAccess: { posts: { update: true } } },
          payload: { collections: { posts: { config } }, config: root },
          user: { id: 1 },
        }) as unknown as PayloadRequest
      const handler = makePublishDraft({ collections: ['posts'] })
      const base = { fields: [], hooks: { beforeChange: [publishPin] }, versions: { drafts: true } }
      await expect(handler({ collection: 'posts', dryRun: true, id: 1 }, fake({ ...base, versions: false }))).rejects.toThrow(/no drafts/)
      const nested = { ...base, fields: [{ type: 'array', fields: [{ type: 'text', name: 't', localized: true }] }] }
      await expect(
        handler({ collection: 'posts', dryRun: true, id: 1 }, fake(nested, { localization: { locales: ['en', 'de'] } })),
      ).rejects.toThrow(/localized fields/)
    })

    it('an MCP write cannot publish, with or without a draft-only hook', async () => {
      const created = await call(secrets.all, 'createRaw', { title: 'Raw' })
      expect(failed(created.body), textOf(created.body)).toBe(false)
      const id = (await payload.find({ collection: 'raw', draft: true, where: { title: { equals: 'Raw' } } })).docs[0]?.id as number
      const out = await call(secrets.all, 'updateRaw', { _status: 'published', draft: false, id, title: 'Raw published' })
      expect(textOf(out.body)).toMatch(/cannot publish/)
      expect((await status('raw', id, true))._status).toBe('draft')
      const live = await payload.create({ collection: 'raw', data: { title: 'Raw live', _status: 'published' } as never, draft: false })
      await call(secrets.all, 'updateRaw', { _status: 'published', draft: false, id: live.id, title: 'Raw live, edited' })
      expect((await status('raw', live.id, false)).title).toBe('Raw live')
    })

    it("a save between the tool's read and its write loses (the tool pins the draft it reviewed)", async () => {
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      // The gate saves a draft after the tool has read and before it writes.
      const { body } = await publish({ collection: 'posts', digest, id, touch: true })
      expect(failed(body)).toBe(true)
      expect(textOf(body)).toMatch(/changed while it was being published/)
      expect((await status('posts', id, false)).title).toBe('Live title')
      expect((await status('posts', id, false))._status).toBe('published')
    })
  })

  describe('a site gate on top of the lane', () => {
    it('the digest binds what the gate adds, and a gate cannot overwrite what the owner reviewed', async () => {
      const created = await payload.create({
        collection: 'case-studies',
        data: { slug: uniq('bound'), title: 'Bound' } as never,
        draft: true,
      })
      const seen = await publish({ collection: 'case-studies', dryRun: true, id: created.id, verification: { basis: 'own-experience' } })
      const digest = /Digest: ([0-9a-f]{64})/.exec(textOf(seen.body))?.[1] ?? ''
      const other = await publish({ collection: 'case-studies', digest, id: created.id, verification: { basis: 'linked-job' } })
      expect(failed(other.body)).toBe(true)
      expect(textOf(other.body)).toMatch(/changed since the dry run/)
      expect(failed((await publish({ collection: 'case-studies', digest, id: created.id })).body)).toBe(true)
      expect((await status('case-studies', created.id, true))._status).toBe('draft')
      for (const clobber of ['title', '_status']) {
        const out = await publish({ clobber, collection: 'case-studies', dryRun: true, id: created.id })
        expect(failed(out.body)).toBe(true)
        expect(textOf(out.body)).toMatch(/may not set/)
      }
    })

    it('a digest is bound to its document: the same content in another document does not carry over', async () => {
      const make = () => payload.create({ collection: 'case-studies', data: { slug: 'same-slug', title: 'Same' } as never, draft: true })
      const [a, b] = [await make(), await make()]
      const verification = { basis: 'own-experience' }
      const seen = await publish({ collection: 'case-studies', dryRun: true, id: a.id, verification })
      const digest = /Digest: ([0-9a-f]{64})/.exec(textOf(seen.body))?.[1] ?? ''
      const { body } = await publish({ collection: 'case-studies', digest, id: b.id, verification })
      expect(textOf(body)).toMatch(/changed since the dry run/)
      expect((await status('case-studies', b.id, true))._status).toBe('draft')
    })

    const bareStudy = async () => {
      const created = await payload.create({
        collection: 'case-studies',
        data: { slug: uniq('bare'), title: 'No basis yet' } as never,
        draft: true,
      })
      return { id: created.id, ...(await dryRun('case-studies', created.id)) }
    }

    it("the collection's own publish gate still decides: a draft with no basis is refused and stays a draft", async () => {
      const { digest, id } = await bareStudy()
      const { body } = await publish({ collection: 'case-studies', digest, id })
      expect(failed(body)).toBe(true)
      expect((await status('case-studies', id, true))._status).toBe('draft')
    })

    it('sets what the gate returns, only when given', async () => {
      const { id } = await bareStudy()
      const verification = { basis: 'documented-source', sourceNote: 'Service bulletin 12' }
      // The dry run takes the same gate arguments: what the gate adds is part of what the digest binds.
      const seen = await publish({ collection: 'case-studies', dryRun: true, id, verification })
      const digest = /Digest: ([0-9a-f]{64})/.exec(textOf(seen.body))?.[1] ?? ''
      const { body } = await publish({ collection: 'case-studies', digest, id, verification })
      expect(failed(body), textOf(body)).toBe(false)
      const live = (await status('case-studies', id, false)) as { _status: string; verification: Record<string, unknown> }
      expect(live._status).toBe('published')
      expect(live.verification.basis).toBe('documented-source')
      expect(live.verification.sourceNote).toBe('Service bulletin 12')
    })

    it('the dry run names what the publish will also set', async () => {
      const { id } = await bareStudy()
      const { body } = await publish({ collection: 'case-studies', dryRun: true, id, verification: { basis: 'own-experience' } })
      expect(textOf(body)).toContain('The publish will also set (in full):')
      expect(textOf(body)).toContain('verification.basis: "own-experience"')
    })

    it('refuses a documented source with no note, and does not overwrite a basis the draft carries', async () => {
      const { digest, id } = await bareStudy()
      expect(failed((await publish({ collection: 'case-studies', digest, id, verification: { basis: 'documented-source' } })).body)).toBe(
        true,
      )
      const live = await liveStudy()
      await call(secrets.all, 'updateCaseStudies', { id: live.id, title: 'Retitled' })
      const dry = await dryRun('case-studies', live.id)
      const forged = await publish({
        collection: 'case-studies',
        digest: dry.digest,
        id: live.id,
        verification: { basis: 'documented-source', sourceNote: 'Forged' },
      })
      expect(failed(forged.body)).toBe(true)
      expect((await status('case-studies', live.id, false)).title).toBe('Live study')
      expect(failed((await publish({ collection: 'case-studies', digest: dry.digest, id: live.id })).body)).toBe(false)
      const after = (await status('case-studies', live.id, false)) as { verification: { basis: string } }
      expect(after.verification.basis).toBe('own-experience')
    })

    it('is refused for a collection with no gate', async () => {
      const { id } = await pendingPost()
      const { digest } = await dryRun('posts', id)
      const { body } = await publish({ collection: 'posts', digest, id, verification: { basis: 'own-experience' } })
      expect(failed(body)).toBe(true)
      expect((await status('posts', id, false)).title).toBe('Live title')
    })
  })
})
