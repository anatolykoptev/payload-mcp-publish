import type { CollectionConfig, CollectionSlug, Payload, PayloadRequest, SanitizedCollectionConfig } from 'payload'
import { NotFound } from 'payload'

/**
 * Has the owner taken a document down? Payload keeps no record: a never-published and an unpublished document both have
 * a draft live row. Without a durable marker the only evidence is the version history. A document whose live row is not
 * published is
 * - `retired` when a published version is in its history;
 * - `never` otherwise.
 *
 * The history is pruned (`versions.maxPerDoc`, oldest first), and once it has lost the published version this inference
 * cannot tell. It is the fallback for a lane without a `retirement` adapter; an adapter such as `durableRetirement`
 * keeps the decision on the document itself.
 */
export type Standing = 'live' | 'never' | 'retired'

/**
 * The lane's source of truth for owner-retired documents. Both sides are required because the guards need both shapes:
 * `publishDraft` and `publishPin` ask about one document, read access asks for the collection. Implementations must be
 * durable under version pruning; the lane falls back to version-history inference when no adapter is configured.
 */
export type RetirementAdapter = {
  isRetired: (payload: Payload, collection: CollectionSlug, id: number | string, req?: PayloadRequest) => Promise<boolean>
  retiredIds: (payload: Payload, collection: CollectionSlug, req?: PayloadRequest) => Promise<(number | string)[]>
  /** Why this adapter cannot protect a collection's wiring, or `undefined`. */
  wiringProblem?: (collection: CollectionConfig | SanitizedCollectionConfig) => string | undefined
}

type Version = { published: boolean }

const judge = (versions: Version[]): Exclude<Standing, 'live'> => (versions.some((v) => v.published) ? 'retired' : 'never')

const SELECT = { parent: true, version: { _status: true } } as const

const toVersion = (v: unknown): Version & { parent: number | string } => {
  const row = v as { parent: number | string; version?: { _status?: string } }
  return { parent: row.parent, published: row.version?._status === 'published' }
}

/** The standing of one document. `live` when its live row is published (or it does not exist). */
export const standingOf = async (payload: Payload, collection: CollectionSlug, id: number | string): Promise<Standing> => {
  let live: { _status?: string } | null = null
  try {
    live = (await payload.findByID({
      collection,
      depth: 0,
      draft: false,
      id,
      overrideAccess: true,
    })) as unknown as { _status?: string }
  } catch (error) {
    if (!(error instanceof NotFound)) throw error
  }
  if (!live || live._status === 'published') return 'live'
  const { docs } = await payload.findVersions({
    collection,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    select: SELECT as never,
    where: { parent: { equals: id } },
  })
  return judge(docs.map(toVersion))
}

/**
 * Ids of the documents of a collection that the owner took down (`retired`, see `Standing`), inferred from version
 * history. One query for the drafts and one for their versions.
 */
export const ownerUnpublishedIds = async (payload: Payload, collection: CollectionSlug): Promise<(number | string)[]> => {
  // Same test as `standingOf`: a live row that is not published (a null status included).
  const notLive = await payload.find({
    collection,
    depth: 0,
    draft: false,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    select: {},
    where: { _status: { not_equals: 'published' } },
  })
  if (!notLive.docs.length) return []
  // Only the published versions of those documents: a handful of rows, one `parent` each.
  const { docs } = await payload.findVersions({
    collection,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    select: { parent: true } as never,
    where: { and: [{ parent: { in: notLive.docs.map((d) => d.id) } }, { 'version._status': { equals: 'published' } }] },
  })
  return [...new Set(docs.map((v) => (v as unknown as { parent: number | string }).parent))]
}

/** The pre-adapter guard: version-history inference. Kept as the fallback when a lane has no `retirement` adapter. */
export const inferredRetirement: RetirementAdapter = {
  isRetired: async (payload, collection, id) => (await standingOf(payload, collection, id)) === 'retired',
  retiredIds: (payload, collection) => ownerUnpublishedIds(payload, collection),
}
