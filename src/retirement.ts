import type { CheckboxField, CollectionAfterChangeHook, CollectionSlug, FieldHook, Payload, PayloadRequest } from 'payload'
import type { RetirementAdapter } from './ownerUnpublished.js'

const FIELD = 'retired'
const CAPTURE = 'mcpPublishRetirement.previousLive'

type LiveRow = {
  _status?: string
  id: number | string
  retired?: boolean
}

type Capture = {
  retired: boolean
  status?: string
}

const captureKey = (collection: string, id: number | string) => JSON.stringify([collection, String(id)])

const readLive = async (payload: Payload, collection: CollectionSlug, id: number | string, req?: Partial<PayloadRequest>) =>
  (await payload.db.findOne({
    collection,
    ...(req ? { req } : {}),
    where: { id: { equals: id } },
  })) as LiveRow | null

const requireRetiredField = (payload: Payload, collection: CollectionSlug): void => {
  const config = payload.collections[collection]?.config
  const present = config?.flattenedFields.some((field) => 'name' in field && field.name === FIELD)
  if (!present) {
    throw new Error(`durableRetirement requires retiredField() in the fields of ${collection}.`)
  }
}

/**
 * The hidden checkbox beforeChange hook is half of the durable write: it reads the live row before the update (when the
 * evidence cannot have been pruned yet) and forces the field itself off in every normal write. `trackRetirement` then
 * writes the real value directly in the same transaction. User input, MCP included, cannot write the marker.
 */
const captureLiveBeforeWrite: FieldHook = async ({ collection, context, data, operation, originalDoc, req }) => {
  if (operation === 'update' && collection) {
    const id = (data?.id ?? originalDoc?.id) as number | string | undefined
    if (id !== undefined) {
      const live = await readLive(req.payload, collection.slug as CollectionSlug, id, req)
      if (!context[CAPTURE]) context[CAPTURE] = {}
      const captures = context[CAPTURE] as Record<string, Capture>
      captures[captureKey(collection.slug, id)] = { retired: live?.retired === true, status: live?._status }
    }
  }
  return false
}

/**
 * The document field `durableRetirement` reads. Add it to every collection the lane covers, next to `trackRetirement`.
 * It is hidden and its value is owned by the lane: normal writes cannot set it.
 */
export const retiredField = (): CheckboxField => ({
  access: {
    create: () => false,
    update: () => false,
  },
  defaultValue: false,
  hidden: true,
  hooks: { beforeChange: [captureLiveBeforeWrite] },
  index: true,
  name: FIELD,
  type: 'checkbox',
})

/**
 * `afterChange` for every collection using `durableRetirement`. When a published live row becomes a draft it writes
 * `retired: true` on the live row; when a document is published again it writes `false`. The write goes through the
 * database adapter inside the same request transaction: it does not create a version, does not re-enter hooks, and is
 * rolled back with the update if a later hook refuses it.
 *
 * The previous live status is captured by `retiredField()` before the write. That ordering matters: Payload prunes
 * versions inside `saveVersion`, before collection `afterChange` hooks, so reading version history here would already
 * be too late exactly for the capped histories this guard exists for.
 */
export const trackRetirement: CollectionAfterChangeHook = async ({ collection, context, doc, operation, req }) => {
  if (!collection.flattenedFields.some((field) => 'name' in field && field.name === FIELD)) {
    throw new Error(`trackRetirement requires retiredField() in the fields of ${collection.slug}.`)
  }
  if (operation !== 'update') return doc

  const id = doc.id as number | string
  const slug = collection.slug as CollectionSlug
  const live = await readLive(req.payload, slug, id, req)
  if (!live) return doc

  const captures = context[CAPTURE] as Record<string, Capture> | undefined
  const key = captureKey(collection.slug, id)
  const before = captures?.[key]
  if (captures && key in captures) delete captures[key]

  const retired = live._status === 'published' ? false : before?.status === 'published' ? true : (before?.retired ?? live.retired) === true

  if ((live.retired === true) !== retired) {
    await req.payload.db.updateOne({
      collection: slug,
      data: { [FIELD]: retired },
      id,
      req,
      returning: false,
    })
  }
  return { ...doc, [FIELD]: retired }
}

/**
 * The durable retirement adapter: the live row's own hidden `retired` marker is the source of truth. It is not inferred
 * from versions, so pruning `versions.maxPerDoc` cannot erase it. Wire `retiredField()` and `trackRetirement` on every
 * collection the lane covers; this adapter refuses with a wiring error when the field is absent.
 */
export const durableRetirement: RetirementAdapter = {
  isRetired: async (payload, collection, id, req) => {
    requireRetiredField(payload, collection)
    const live = await readLive(payload, collection, id, req)
    return Boolean(live && live._status !== 'published' && live.retired === true)
  },
  retiredIds: async (payload, collection, req) => {
    requireRetiredField(payload, collection)
    const { docs } = await payload.db.find({
      collection,
      limit: 0,
      pagination: false,
      ...(req ? { req } : {}),
      where: { and: [{ _status: { not_equals: 'published' } }, { [FIELD]: { equals: true } }] },
    })
    return docs.map((doc) => doc.id)
  },
}
