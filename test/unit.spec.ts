import type { CollectionConfig, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  diffSummary,
  hideOwnerUnpublishedFromMcp,
  lexicalText,
  mcpPublishLane,
  publishPin,
  retiredField,
  trackRetirement,
} from '../src/index.js'
import { offByDefault } from '../src/lane.js'
import { durableRetirementWiringProblem } from '../src/retirement.js'

/**
 * Mutations: src/lane.ts `offByDefault` setting `defaultValue: false` on every checkbox, or not recursing into
 * `payload-mcp-tool`: "unticks only the named tool checkboxes". `overrideAuth` not calling `inner` or not stashing:
 * the two `overrideAuth` cases. `mcpPublishLane` without the empty-list check: "refuses an empty lane".
 * src/retirement.ts identifying the marker by name rather than `retiredFieldMarker`: "accepts only the marked field
 * and collection hook together". `trackRetirement` clearing the marker on a lane publish: "keeps the marker on a
 * pinned lane publish".
 */
const keys = (): CollectionConfig => ({
  slug: 'payload-mcp-api-keys',
  fields: [
    { name: 'label', type: 'text' },
    {
      type: 'collapsible',
      label: 'Tools',
      fields: [
        {
          name: 'payload-mcp-tool',
          type: 'group',
          fields: [
            { name: 'publishDraft', type: 'checkbox', defaultValue: true },
            { name: 'ogCard', type: 'checkbox', defaultValue: true },
            { name: 'other', type: 'checkbox', defaultValue: true },
          ],
        },
      ],
    },
    { name: 'flag', type: 'checkbox', defaultValue: true },
  ],
})

const defaults = (c: CollectionConfig) => {
  const out: Record<string, unknown> = {}
  const visit = (fields: CollectionConfig['fields']) => {
    for (const f of fields) {
      if ('name' in f && f.type === 'checkbox') out[f.name] = f.defaultValue
      if ('fields' in f && f.fields) visit(f.fields)
    }
  }
  visit(c.fields)
  return out
}

describe('mcpPublishLane', () => {
  it('unticks only the named tool checkboxes, inside the tool group', () => {
    const lane = mcpPublishLane({ collections: ['posts'] })
    expect(defaults(lane.offByDefault(keys()))).toEqual({ flag: true, ogCard: true, other: true, publishDraft: false })
    expect(defaults(lane.offByDefault(keys(), ['ogCard']))).toEqual({ flag: true, ogCard: false, other: true, publishDraft: false })
    expect(defaults(offByDefault(keys(), new Set(['publishDraft', 'other'])))).toMatchObject({ other: false, ogCard: true })
  })

  it('refuses an empty lane', () => {
    expect(() => mcpPublishLane({ collections: [] })).toThrow(/at least one collection/)
  })

  it('keeps the legacy pin and read helper on a plain lane, and makes adapter closures on a retirement lane', () => {
    const plain = mcpPublishLane({ collections: ['posts'] })
    expect(plain.publishPin).toBe(publishPin)
    expect(plain.hideOwnerUnpublishedFromMcp).toBe(hideOwnerUnpublishedFromMcp)

    const retirement = { isRetired: async () => false, retiredIds: async () => [] }
    const durable = mcpPublishLane({ collections: ['posts'], retirement })
    expect(durable.publishPin).not.toBe(publishPin)
    expect(durable.hideOwnerUnpublishedFromMcp).not.toBe(hideOwnerUnpublishedFromMcp)
  })

  it('refuses a partial retirement adapter', () => {
    expect(() => mcpPublishLane({ collections: ['posts'], retirement: { isRetired: async () => false } as never })).toThrow(
      /isRetired.*retiredIds/,
    )
  })

  it('overrideAuth stashes the resolved access on the request and returns it', async () => {
    const lane = mcpPublishLane({ collections: ['posts'] })
    const req = { context: {} } as unknown as PayloadRequest
    const resolved = { posts: { update: true } }
    const out = await lane.overrideAuth()(req, async () => resolved)
    expect(out).toBe(resolved)
    expect((req.context as { mcpAccess?: unknown }).mcpAccess).toBe(resolved)
  })

  it("overrideAuth stashes what the site's override returned, not what the plugin resolved", async () => {
    const lane = mcpPublishLane({ collections: ['posts'] })
    const req = {} as unknown as PayloadRequest
    const wide = { pages: { update: true }, posts: { update: true } }
    const narrow = { posts: { update: true } }
    const forwarded: unknown[] = []
    const out = await lane.overrideAuth<typeof wide>(async (_r, get) => {
      await get('override-key')
      return narrow as never
    })(req, async (key) => {
      forwarded.push(key)
      return wide
    })
    expect(out).toBe(narrow)
    expect(forwarded).toEqual(['override-key'])
    expect((req.context as { mcpAccess?: unknown }).mcpAccess).toBe(narrow)
  })

  it("refuses gate parameters that shadow the tool's own", () => {
    for (const name of ['collection', 'id', 'digest', 'dryRun']) {
      expect(() =>
        mcpPublishLane({ collections: ['posts'], gate: { check: () => undefined, parameters: { [name]: z.string() } } }),
      ).toThrow(/may not reuse/)
    }
  })

  it("overrideAuth runs the site's own override on top, and the stash still happens", async () => {
    const lane = mcpPublishLane({ collections: ['posts'] })
    const req = {} as unknown as PayloadRequest
    const resolved = { user: {} as { _strategy?: string } }
    const out = await lane.overrideAuth<typeof resolved>(async (_r, get) => {
      const r = await get()
      r.user._strategy = 'api-key'
      return r
    })(req, async () => resolved)
    expect(out.user._strategy).toBe('api-key')
    expect((req.context as { mcpAccess?: unknown }).mcpAccess).toBe(resolved)
  })
})

describe('durable retirement wiring', () => {
  const problem = (fields: CollectionConfig['fields'], afterChange: unknown[]) =>
    durableRetirementWiringProblem({ fields, hooks: { afterChange }, slug: 'posts' })

  it('accepts only the marked field and collection hook together', () => {
    expect(problem([retiredField()], [trackRetirement])).toBeUndefined()
    expect(problem([{ name: 'retired', type: 'checkbox' }], [trackRetirement])).toMatch(/retiredField/)
    const unmarked = retiredField()
    for (const symbol of Object.getOwnPropertySymbols(unmarked)) Reflect.deleteProperty(unmarked, symbol)
    expect(problem([unmarked], [trackRetirement])).toMatch(/retiredField/)
    expect(problem([retiredField()], [])).toMatch(/trackRetirement/)
    expect(problem([], [trackRetirement])).toMatch(/retiredField/)
    expect(problem([{ ...retiredField(), hooks: {} }], [trackRetirement])).toMatch(/retiredField/)
  })

  it('keeps the marker on a pinned lane publish and returns the response document unchanged', async () => {
    const field = retiredField()
    const collection = {
      fields: [field],
      flattenedFields: [field],
      hooks: { afterChange: [trackRetirement] },
      slug: 'posts',
    }
    const writes: unknown[] = []
    const payload = {
      db: {
        findOne: async () => ({ _status: 'published', id: 1, retired: false }),
        updateOne: async (args: { data: unknown }) => {
          writes.push(args.data)
          return null
        },
      },
    }
    const doc = { id: 1, title: 'Published' }
    const context = {
      publishPin: 1,
      'mcpPublishRetirement.previousLive': { [JSON.stringify(['posts', '1'])]: { retired: true, status: 'draft' } },
    }
    const result = await trackRetirement({ collection, context, doc, operation: 'update', req: { payload } } as never)
    expect(writes).toEqual([{ retired: true }])
    expect(result).toBe(doc)
  })
})

describe('rich text rendering', () => {
  const root = (...children: unknown[]) => ({ root: { children, type: 'root' } })
  const upload = (value: number) => ({ fields: { alt: 'A chart' }, relationTo: 'media', type: 'upload', value, version: 3 })

  it('carries what upload, relationship and block nodes hold, and a heading level', () => {
    const text = lexicalText(
      root(
        { children: [{ text: 'Title', type: 'text' }], tag: 'h2', type: 'heading' },
        upload(7),
        { relationTo: 'posts', type: 'relationship', value: { id: 9 }, version: 1 },
        { fields: { blockType: 'cta', label: 'Buy now' }, type: 'inlineBlock', version: 1 },
      ),
    )
    expect(text).toContain('## Title')
    expect(text).toContain('"value":7')
    expect(text).toContain('"alt":"A chart"')
    expect(text).toContain('"value":{"id":9}')
    expect(text).toContain('"label":"Buy now"')
  })

  it('shows a swapped upload as a change, never as identical text', () => {
    const before = { body: root(upload(1)) }
    const after = { body: root(upload(2)) }
    const lines = diffSummary(before, after).join('\n')
    expect(lines).toContain('\\"value\\":1')
    expect(lines).toContain('\\"value\\":2')
    expect(lines).not.toContain('identical')
  })

  it('shows where an internal link points, so a repointed one is a change', () => {
    const link = (id: number) => ({
      children: [{ text: 'read more', type: 'text' }],
      fields: { doc: { relationTo: 'posts', value: id }, linkType: 'internal', newTab: false },
      type: 'link',
    })
    const text = lexicalText({ root: { children: [{ children: [link(3)], type: 'paragraph' }], type: 'root' } })
    expect(text).toContain('read more')
    expect(text).toContain('"value":3')
    const lines = diffSummary(
      { body: { root: { children: [link(3)], type: 'root' } } },
      { body: { root: { children: [link(4)], type: 'root' } } },
    ).join('\n')
    expect(lines).toContain('\\"value\\":4')
    expect(lines).not.toContain('identical')
  })
})
