import type {
  CheckboxField,
  CollectionAfterChangeHook,
  CollectionSlug,
  Field,
  FieldHook,
  FlattenedField,
  Payload,
  PayloadRequest,
} from 'payload'
import { flattenAllFields } from 'payload'
import { ownerUnpublishedIds, type RetirementAdapter } from './ownerUnpublished.js'

const FIELD = 'retired'
const CAPTURE = 'mcpPublishRetirement.previousLive'

/** Set by `retiredField()`: the wiring check knows the real marker field without trusting the storage name. */
export const retiredFieldMarker: unique symbol = Symbol.for('payload-mcp-publish.retiredField')

type LiveRow = {
  _status?: string
  id: number | string
  retired?: boolean
}

type Capture = {
  retired: boolean
  status?: string
}

type WiringCollection = {
  fields: Field[]
  flattenedFields?: FlattenedField[]
  hooks?: { afterChange?: unknown[] }
  slug: string
}

const captureKey = (collection: string, id: number | string) => JSON.stringify([collection, String(id)])

const readLive = async (payload: Payload, collection: CollectionSlug, id: number | string, req?: Partial<PayloadRequest>) =>
  (await payload.db.findOne({
    collection,
    ...(req ? { req } : {}),
    where: { id: { equals: id } },
  })) as LiveRow | null

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
export const retiredField = (): CheckboxField =>
  ({
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
    [retiredFieldMarker]: true,
  }) as CheckboxField

/**
 * `afterChange` for every collection using `durableRetirement`. When a published live row becomes a draft it writes
 * `retired: true` on the live row; when the owner publishes it again it writes `false`. The write goes through the
 * database adapter inside the same request transaction: it does not create a version, does not re-enter hooks, and is
 * rolled back with the update if a later hook refuses it.
 *
 * The previous live status is captured by `retiredField()` before the write. That ordering matters: Payload prunes
 * versions inside `saveVersion`, before collection `afterChange` hooks, so reading version history here would already
 * be too late exactly for the capped histories this guard exists for.
 */
export const trackRetirement: CollectionAfterChangeHook = async ({ collection, context, doc, operation, req }) => {
  const wiring = durableRetirementWiringProblem(collection)
  if (wiring) throw new Error(wiring)
  if (operation !== 'update') return doc

  const id = doc.id as number | string
  const slug = collection.slug as CollectionSlug
  const live = await readLive(req.payload, slug, id, req)
  if (!live) return doc

  const captures = context[CAPTURE] as Record<string, Capture> | undefined
  const key = captureKey(collection.slug, id)
  const before = captures?.[key]
  if (captures && key in captures) delete captures[key]

  const lanePublish = (context as { publishPin?: unknown }).publishPin !== undefined
  const beforeRetired = (before?.retired ?? live.retired) === true
  const retired =
    live._status === 'published' ? (lanePublish ? beforeRetired : false) : before?.status === 'published' ? true : beforeRetired

  if ((live.retired === true) !== retired) {
    await req.payload.db.updateOne({
      collection: slug,
      data: { [FIELD]: retired },
      id,
      req,
      returning: false,
    })
  }
  return doc
}

/** Why `durableRetirement` cannot protect this collection, or `undefined` when field and hook are both wired. */
export const durableRetirementWiringProblem = (collection: WiringCollection): string | undefined => {
  const flattened = collection.flattenedFields ?? flattenAllFields({ cache: true, fields: collection.fields })
  const field = flattened.some((candidate) => {
    const marked = candidate as CheckboxField & { [retiredFieldMarker]?: unknown }
    return marked[retiredFieldMarker] === true && (marked.hooks?.beforeChange ?? []).includes(captureLiveBeforeWrite)
  })
  if (!field) {
    return `durableRetirement requires retiredField() in the fields of ${collection.slug}.`
  }
  if (!(collection.hooks?.afterChange ?? []).includes(trackRetirement)) {
    return `durableRetirement requires trackRetirement in the afterChange hooks of ${collection.slug}.`
  }
  return undefined
}

const requireWiredCollection = (payload: Payload, collection: CollectionSlug): void => {
  const config = payload.collections[collection]?.config
  if (!config) throw new Error(`durableRetirement: ${collection} is not a collection of this site.`)
  const problem = durableRetirementWiringProblem(config)
  if (problem) throw new Error(problem)
}

/**
 * Mark documents that were already retired before durable enforcement, using the same version-history inference the
 * lane used before the adapter. Only a row that is still unpublished is marked; an owner republish after that write
 * clears it through `trackRetirement`. Returns the ids it marked.
 */
export const backfillRetirement = async (payload: Payload, collection: CollectionSlug): Promise<(number | string)[]> => {
  requireWiredCollection(payload, collection)
  const marked: (number | string)[] = []
  for (const id of await ownerUnpublishedIds(payload, collection)) {
    const updated = await payload.db.updateOne({
      collection,
      data: { [FIELD]: true },
      where: { and: [{ id: { equals: id } }, { _status: { not_equals: 'published' } }] },
    })
    if (updated) marked.push(id)
  }
  return marked
}

/**
 * The durable retirement adapter: the live row's own hidden `retired` marker is the source of truth. It is not inferred
 * from versions, so pruning `versions.maxPerDoc` cannot erase it. Wire `retiredField()` and `trackRetirement` on every
 * collection the lane covers; this adapter refuses with a wiring error when either side is absent.
 */
export const durableRetirement: RetirementAdapter = {
  isRetired: async (payload, collection, id, req) => {
    requireWiredCollection(payload, collection)
    const live = await readLive(payload, collection, id, req)
    return Boolean(live && live._status !== 'published' && live.retired === true)
  },
  retiredIds: async (payload, collection, req) => {
    requireWiredCollection(payload, collection)
    const { docs } = await payload.db.find({
      collection,
      limit: 0,
      pagination: false,
      ...(req ? { req } : {}),
      where: { and: [{ _status: { not_equals: 'published' } }, { [FIELD]: { equals: true } }] },
    })
    return docs.map((doc) => doc.id)
  },
  wiringProblem: durableRetirementWiringProblem,
}
