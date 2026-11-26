import type { CollectionSlug, Payload, PayloadRequest } from 'payload'
import { NotFound } from 'payload'

/**
 * Has the owner taken a document down? Payload answers this nowhere: a never-published document and an unpublished one
 * both have a draft live row. The only evidence is the version history, and that is pruned (`versions.maxPerDoc`,
 * oldest first, whatever their status), so an agent saving drafts before or after the owner's unpublish can push the
 * published version out.
 *
 * The lane therefore fails closed. A document whose live row is not published is
 * - `retired` when a published version is still in its history;
 * - `never` only when the history provably holds every version the document ever had: fewer than `maxPerDoc` of them
 *   (Payload prunes only past the limit), or `maxPerDoc: 0` (keep all). No timestamp is trusted: Payload's own first
 *   version differs from its document's by a millisecond or none;
 * - `pruned` otherwise: it may have been published once. The lane refuses to publish it and to edit it over MCP; the
 *   owner publishes or edits it in the admin. A draft that has been saved `maxPerDoc` times lands here too.
 */
export type Standing = 'live' | 'never' | 'pruned' | 'retired'

/** Payload keeps 100 versions per document unless told otherwise; 0 keeps all. */
const DEFAULT_MAX_PER_DOC = 100
type Version = { published: boolean }

const maxPerDoc = (payload: Payload, collection: string): number => {
  const versions = payload.collections[collection as CollectionSlug]?.config.versions
  return typeof versions === 'object' && versions ? (versions.maxPerDoc ?? DEFAULT_MAX_PER_DOC) : DEFAULT_MAX_PER_DOC
}

const judge = (versions: Version[], max: number): Exclude<Standing, 'live'> => {
  if (versions.some((v) => v.published)) return 'retired'
  return max === 0 || versions.length < max ? 'never' : 'pruned'
}

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
  return judge(docs.map(toVersion), maxPerDoc(payload, collection))
}

/**
 * Ids of the documents of a collection that the lane must treat as taken down: `retired` or `pruned` (see `Standing`).
 * One query for the drafts and one for their versions.
 */
export const ownerUnpublishedIds = async (payload: Payload, collection: CollectionSlug): Promise<(number | string)[]> => {
  const drafts = await payload.find({
    collection,
    depth: 0,
    draft: false,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    select: {},
    where: { _status: { equals: 'draft' } },
  })
  if (!drafts.docs.length) return []
  const { docs } = await payload.findVersions({
    collection,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    select: SELECT as never,
    where: { parent: { in: drafts.docs.map((d) => d.id) } },
  })
  const byParent = new Map<number | string, Version[]>()
  for (const raw of docs) {
    const v = toVersion(raw)
    byParent.set(v.parent, [...(byParent.get(v.parent) ?? []), v])
  }
  const max = maxPerDoc(payload, collection)
  return drafts.docs.filter((d) => judge(byParent.get(d.id) ?? [], max) !== 'never').map((d) => d.id)
}
