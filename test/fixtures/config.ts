import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { mcpPlugin } from '@payloadcms/plugin-mcp'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, type CollectionConfig } from 'payload'
import { z } from 'zod'
import { hideOwnerUnpublishedFromMcp, mcpPublishLane } from '../../src/index.js'
import { draftOnly } from './draftOnly.js'

const dir = path.resolve(process.cwd(), 'test/.tmp')
mkdirSync(dir, { recursive: true })

const readLatest = ({ req: { user } }: { req: { user?: unknown } }) => (user ? true : { _status: { equals: 'published' } })

/** A site's own publish gate (a "verification basis"): the owner states what a page rests on. */
const BASES = ['own-experience', 'linked-job', 'documented-source'] as const
const gate = {
  parameters: {
    verification: z
      .object({ basis: z.enum(BASES), sourceNote: z.string().optional() })
      .optional()
      .describe('Only for a document whose draft has no basis. Not accepted for collections without a gate.'),
    // Test levers: a gate that saves a draft between the tool's read and its write, and one that tries to overwrite content.
    touch: z.boolean().optional(),
    clobber: z.enum(['title', '_status']).optional(),
  },
  check: async ({
    args,
    collection,
    draft,
    req,
  }: {
    args: Record<string, unknown>
    collection: string
    draft: Record<string, unknown>
    req: any
  }) => {
    if (args.touch) await req.payload.update({ collection: 'posts', data: { title: 'Moved after the read' }, draft: true, id: draft.id })
    if (args.clobber) return { data: { [args.clobber as string]: args.clobber === '_status' ? 'draft' : 'Overwritten by the gate' } }
    const verification = args.verification as undefined | { basis: (typeof BASES)[number]; sourceNote?: string }
    if (!verification) return
    const gated = req.payload.collections[collection].config.flattenedFields.some((f: { name: string }) => f.name === 'verification')
    if (!gated) return `${collection} has no publish gate: do not pass \`verification\`.`
    const had = (draft.verification as { basis?: string | null } | null | undefined)?.basis
    if (had) return `${collection}/${String(draft.slug)} already carries a basis (${had}); only the owner changes it, in the admin.`
    if (verification.basis === 'documented-source' && !verification.sourceNote?.trim())
      return 'A documented source needs `sourceNote` naming it.'
    return {
      data: { verification: { basis: verification.basis, ...(verification.sourceNote ? { sourceNote: verification.sourceNote } : {}) } },
    }
  },
}

export const lane = mcpPublishLane({
  collections: ['posts', 'case-studies', 'unwired'],
  gate,
  urlFor: (collection, doc) => `https://example.test/${collection}/${String(doc.slug)}`,
})

const hooks = {
  beforeChange: [lane.publishPin],
  beforeOperation: [draftOnly],
}

const posts: CollectionConfig = {
  slug: 'posts',
  access: { read: readLatest },
  hooks,
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text' },
    { name: 'blurb', type: 'textarea' },
    { name: 'body', type: 'richText' },
    {
      name: 'sections',
      type: 'array',
      fields: [
        { name: 'heading', type: 'text' },
        { name: 'text', type: 'textarea' },
      ],
    },
  ],
}

// Hyphenated slug (`caseStudies` on a key), a short history so pruning is reachable, a publish gate, and a read
// that hides what the owner took down from an MCP key.
const caseStudies: CollectionConfig = {
  slug: 'case-studies',
  access: { read: hideOwnerUnpublishedFromMcp('case-studies', readLatest as never) },
  hooks,
  versions: { drafts: true, maxPerDoc: 3 },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text' },
    { name: 'summary', type: 'textarea' },
    {
      name: 'verification',
      type: 'group',
      fields: [
        {
          name: 'basis',
          type: 'select',
          options: [...BASES],
          validate: (value: unknown, { data }: { data?: { _status?: string } }) =>
            data?._status === 'published' && !value ? 'A basis is required to publish.' : true,
        },
        { name: 'sourceNote', type: 'text' },
      ],
    },
  ],
}

// Writable over MCP but not in the lane: it must never publish from here.
const notes: CollectionConfig = {
  slug: 'notes',
  hooks: { beforeOperation: [draftOnly] },
  versions: { drafts: true },
  fields: [{ name: 'title', type: 'text' }],
}

// Listed in the lane but never given `publishPin`: the tool must refuse it.
const unwired: CollectionConfig = {
  slug: 'unwired',
  hooks: { beforeOperation: [draftOnly] },
  versions: { drafts: true },
  fields: [{ name: 'title', type: 'text' }],
}

// Has the pin but no draft-only hook (a site that forgot it): the pin itself must keep MCP from publishing.
const raw: CollectionConfig = {
  slug: 'raw',
  hooks: { beforeChange: [lane.publishPin] },
  versions: { drafts: true },
  fields: [{ name: 'title', type: 'text' }],
}

export default (name: string) =>
  buildConfig({
    secret: 'test-secret',
    serverURL: 'http://localhost:3000',
    collections: [{ slug: 'users', auth: true, fields: [] }, posts, caseStudies, notes, unwired, raw],
    db: sqliteAdapter({ client: { url: `file:${path.join(dir, `${name}.db`)}` } }),
    editor: lexicalEditor(),
    jobs: { autoRun: [] },
    plugins: [
      mcpPlugin({
        collections: {
          posts: { enabled: { create: true, find: true, update: true } },
          'case-studies': { enabled: { create: true, find: true, update: true } },
          notes: { enabled: { find: true, update: true } },
          unwired: { enabled: { find: true, update: true } },
          raw: { enabled: { create: true, find: true, update: true } },
        },
        overrideAuth: lane.overrideAuth(),
        overrideApiKeyCollection: (collection) => lane.offByDefault(collection),
        mcp: { tools: [lane.tool] },
      }),
    ],
  })
