import type { CollectionSlug, Payload, PayloadRequest } from 'payload'
import { NotFound } from 'payload'

/**
 * Has the owner taken a document down? Payload keeps no record: a never-published and an unpublished document both have
 * a draft live row, and the only evidence is the version history. A document whose live row is not published is
 * - `retired` when a published version is in its history;
 * - `never` otherwise.
 *
 * The history is pruned (`versions.maxPerDoc`, oldest first), and once it has lost the published version the guard cannot
 * tell. Retired documents are best deleted: delete what you retire. Until then the lane refuses every MCP update of a
 * `retired` document, so an agent cannot push the evidence out by saving drafts.
 */
export type Standing = 'live' | 'never' | 'retired'

type Version = { published: boolean }

const judge = (versions: Version[]): Exclude<Standing, 'live'> => (versions.some((v) => v.published) ? 'retired' : 'never')

const SELECT = { parent: true, version: { _status: true } } as const

const toVersion = (v: unknown): Version & { parent: number | string } => {
  const row = v as { parent: number | string; version?: { _status?: string } }
  return { parent: row.parent, published: row.version?._status === 'published' }
}

/** The standing of one document. `live` when its live row is published (or it does not exist). */
export const standingOf = async (
  payload: Payload,
  collection: CollectionSlug,
  id: number | string,
  req?: PayloadRequest,
): Promise<Standing> => {
  let live: { _status?: string } | null = null
  try {
    live = (await payload.findByID({
      collection,
      depth: 0,
      draft: false,
      id,
      overrideAccess: true,
      ...(req ? { req } : {}),
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
    ...(req ? { req } : {}),
  })
  return judge(docs.map(toVersion))
}

/**
 * Ids of the documents of a collection that the owner took down (`retired`, see `Standing`).
 * One query for the drafts and one for their versions.
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
