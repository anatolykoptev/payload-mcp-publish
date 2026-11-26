import type { PayloadRequest } from 'payload'
import { APIError, NotFound } from 'payload'
import { z } from 'zod'
import { camel } from './camel.js'
import { contentDigest, diffSummary, isEmptyValue, mismatches } from './diff.js'
import { standingOf } from './ownerUnpublished.js'
import { wiringProblem } from './wiring.js'

type Doc = Record<string, unknown>

/** What a publish gate sees. */
export type GateContext = {
  /** The collection slug. */
  collection: string
  /** The latest draft, exactly as it will go live. */
  draft: Doc
  /** The tool's arguments, including those the gate declared in `parameters`. */
  args: Record<string, unknown>
  /** The live version, when there is one. */
  live: Doc | undefined
  req: PayloadRequest
}

/** What a gate answers: a refusal message, fields to add to the publishing write, or `undefined` to pass. */
export type GateVerdict = string | { data?: Record<string, unknown> } | undefined

/**
 * A site's own rule on top of the lane (a "verification basis" the owner must state, a required field,
 * a freshness check). `check` runs on the dry run and again on the publish. Return a string to refuse
 * with that message, `{ data }` to merge fields into the publishing write, or nothing to pass.
 */
export type PublishGate = {
  check: (ctx: GateContext) => GateVerdict | Promise<GateVerdict>
  /** Extra tool arguments the gate reads from `ctx.args`, as zod values. */
  parameters?: z.ZodRawShape
}

export type PublishToolOptions = {
  collections: readonly string[]
  gate?: PublishGate
  /** The public URL of a published document, for the tool's answer. Without it the answer carries no link. */
  urlFor?: (collection: string, doc: Doc) => string | undefined
}

const refuse = (message: string): never => {
  throw new APIError(message, 400, undefined, true)
}

/**
 * The publish call of the lane. Two steps, so the owner's approval sees the content:
 * 1. `dryRun: true` changes nothing and returns every field that would change against the live
 *    version, in full, and a `digest` of the whole draft;
 * 2. the publish call passes that `digest`. The server recomputes it from the latest draft and refuses
 *    on any difference, and the update itself re-checks the draft it builds on (`publishPin`, inside the
 *    transaction), so a save between the check and the write loses.
 */
export const makePublishDraft = (o: PublishToolOptions) => async (args: Record<string, unknown>, req: PayloadRequest) => {
  const { payload, user } = req
  if (!user) return refuse('Not authenticated.')

  const collection = args.collection as string
  if (!o.collections.includes(collection)) {
    return refuse(`\`${collection}\` cannot be published from here. Allowed: ${o.collections.join(', ')}.`)
  }
  const slug = collection as never
  const unwired = wiringProblem(payload, collection)
  if (unwired) return refuse(unwired)
  // The key must be allowed to edit this collection, not only to publish.
  const access = (req.context as { mcpAccess?: Record<string, { update?: boolean } | undefined> } | undefined)?.mcpAccess
  if (access?.[camel(collection)]?.update !== true) {
    return refuse(`This key cannot update ${collection}, so it cannot publish ${collection}.`)
  }

  const id = args.id as number | string
  const dryRun = args.dryRun === true
  const digest = typeof args.digest === 'string' ? args.digest : ''
  if (!dryRun && !digest) return refuse('Run it with `dryRun: true` first, show the owner what it returns, then pass its `digest`.')

  // As the key's user, with the collection's own access rules, like the plugin's own tools. Only a
  // missing document is "not found"; any other failure (access, database) is reported as it is.
  const as = { depth: 0, overrideAccess: false, user } as const
  const read = async (draft: boolean): Promise<Doc | null> => {
    try {
      return (await payload.findByID({ collection: slug, draft, id, ...as })) as unknown as Doc
    } catch (error) {
      if (error instanceof NotFound) return null
      throw error
    }
  }
  const latest = await read(true)
  if (!latest) return refuse(`${collection} #${String(id)} not found.`)
  const name = `${collection}/${String(latest.slug ?? id)}`

  if (latest._status === 'published') return refuse(`${name} has no pending draft: the live version is the latest.`)

  // Only a draft on top of a live version, or a document never published, may go live. A live row that is a
  // draft with a published version in its history is one the owner took down.
  const liveRow = await read(false)
  const live = liveRow?._status === 'published' ? liveRow : undefined
  if (!live) {
    const standing = await standingOf(payload, slug, id)
    if (standing === 'retired') return refuse(`${name} was unpublished by the owner; republish in the admin.`)
  }

  const verdict = await o.gate?.check({ args, collection, draft: latest, live, req })
  if (typeof verdict === 'string') return refuse(verdict)
  const gateData = verdict && typeof verdict === 'object' ? (verdict.data ?? {}) : {}
  // What the gate adds is part of what the owner approves: it may fill an empty field, never overwrite reviewed content.
  for (const key of Object.keys(gateData)) {
    if (key === '_status' || key in { createdAt: 1, id: 1, updatedAt: 1 } || !isEmptyValue(latest[key])) {
      return refuse(`The publish gate may not set \`${key}\`: the draft already carries it, or it is a system field.`)
    }
  }

  const current = contentDigest(latest, live, { collection, gate: gateData, id })
  if (dryRun) {
    return {
      content: [
        {
          text: [
            `DRY RUN, nothing published: ${name} (#${String(id)}).`,
            `Digest: ${current}`,
            live
              ? 'Changes against the live version (every changed field, in full):'
              : 'Never published (or its published history was pruned): the whole document is shown:',
            ...diffSummary(live, latest),
            ...(Object.keys(gateData).length ? ['The publish will also set (in full):', ...diffSummary(undefined, gateData)] : []),
            'Show the owner this, then call again with `digest`.',
          ].join('\n'),
          type: 'text' as const,
        },
      ],
    }
  }
  if (digest !== current) {
    return refuse(`${name} changed since the dry run (or the digest is wrong). Run \`dryRun\` again and show the owner.`)
  }

  const lines = diffSummary(live, latest)
  // Local API without `req`: the MCP request would make a site's draft-only hook save this as a draft
  // again. Payload merges this onto the latest draft, so what goes live is exactly what was reviewed,
  // and `publishPin` re-checks inside the update that the draft it builds on is the one digested above.
  const after = (await payload.update({
    collection: slug,
    context: { publishPin: Date.parse(String(latest.updatedAt)) },
    data: { ...gateData, _status: 'published' },
    draft: false,
    id,
    ...as,
  })) as unknown as Doc

  const drift = mismatches(latest, after, new Set(Object.keys(gateData)))
  const url = o.urlFor?.(collection, after)
  return {
    content: [
      {
        text: [
          `Published ${name} (#${String(id)}).`,
          ...(url ? [`Live: ${url}`] : []),
          'Changed from the live version:',
          ...lines,
          ...(drift.length ? [`WARNING: live differs from the reviewed draft in: ${drift.join(', ')}`] : []),
        ].join('\n'),
        type: 'text' as const,
      },
    ],
  }
}

export const publishDraftDescription =
  'Publish ONE reviewed draft: the latest draft of one document, exactly as it stands. Two steps. ' +
  '1) Call with `dryRun: true`: nothing changes; it returns every field that would change, in full, and a `digest`. SHOW THAT DIFF TO THE OWNER and wait for their yes. ' +
  '2) Call again without `dryRun`, passing that `digest` and exactly the same other arguments (any gate arguments such as `verification` go on BOTH calls: the digest covers them); the owner approves this call. It is refused when the draft or those arguments changed since the dry run, ' +
  'when there is no pending draft, when the owner unpublished the document, and when the key cannot update that collection. ' +
  "The digest is not the owner's consent: it only proves the draft is the one that was shown. Returns what changed and, when the site gives one, the live URL."

export const publishDraftParameters = (o: PublishToolOptions): z.ZodRawShape => {
  const [first, ...rest] = o.collections
  return {
    collection: z.enum([first as string, ...rest]).describe('The collection of the document.'),
    digest: z.string().optional().describe('From the dry run the owner saw. Required unless `dryRun`.'),
    dryRun: z.boolean().optional().describe('True: change nothing, return the diff and the digest.'),
    id: z.union([z.number().int(), z.string().min(1)]).describe('The document id.'),
    ...o.gate?.parameters,
  }
}
