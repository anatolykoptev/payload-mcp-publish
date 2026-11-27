import type { CheckboxField, CollectionSlug, Field, FieldHook, FlattenedField, Payload, PayloadRequest } from 'payload'
import { flattenAllFields } from 'payload'
import { ownerUnpublishedIds, type RetirementAdapter } from './ownerUnpublished.js'

const FIELD = 'retired'

/** Set by `retiredField()`: the wiring check knows the real marker field without trusting the storage name. */
export const retiredFieldMarker: unique symbol = Symbol.for('payload-mcp-publish.retiredField')

type LiveRow = {
  _status?: string
  id: number | string
  retired?: boolean
}

type WiringCollection = {
  fields: Field[]
  flattenedFields?: FlattenedField[]
  slug: string
}

const readLive = async (payload: Payload, collection: CollectionSlug, id: number | string, req?: Partial<PayloadRequest>) =>
  (await payload.db.findOne({
    collection,
    ...(req ? { req } : {}),
    where: { id: { equals: id } },
  })) as LiveRow | null

/**
 * The hidden checkbox beforeChange hook is the durable write: it reads the live row before the update (when the evidence
 * cannot have been pruned yet) and returns the marker value, so Payload stores it in the same row update as the owner's
 * status change. User input, MCP included, cannot write the marker: field access refuses it and this hook ignores `value`.
 */
const retirementBeforeChange: FieldHook = async ({ collection, context, data, draft, operation, originalDoc, previousValue, req }) => {
  const before = previousValue === true
  if (operation !== 'update' || !collection) return before
  const id = (data?.id ?? originalDoc?.id) as number | string | undefined
  if (id === undefined) return before

  const live = await readLive(req.payload, collection.slug as CollectionSlug, id, req)
  const stored = live ? live.retired === true : before
  if ((context as { publishPin?: unknown }).publishPin !== undefined) return stored

  const incoming = (data as { _status?: unknown } | undefined)?._status
  if (incoming === 'published') return false

  const queryDraft = (req.query as { draft?: unknown } | undefined)?.draft
  if (draft === true || queryDraft === true || queryDraft === 'true' || (req.payloadAPI as string) === 'MCP') return stored
  if (incoming === 'draft' && live?._status === 'published') return true
  return stored
}

/**
 * The document field `durableRetirement` reads. Add it to every collection the lane covers. It is hidden and its value
 * is owned by the lane: normal writes cannot set it.
 */
export const retiredField = (): CheckboxField =>
  ({
    access: {
      create: () => false,
      update: () => false,
    },
    defaultValue: false,
    hidden: true,
    hooks: { beforeChange: [retirementBeforeChange] },
    index: true,
    name: FIELD,
    type: 'checkbox',
    [retiredFieldMarker]: true,
  }) as CheckboxField

/** Why `durableRetirement` cannot protect this collection, or `undefined` when the marked field and its hook are wired. */
export const durableRetirementWiringProblem = (collection: WiringCollection): string | undefined => {
  const flattened = collection.flattenedFields ?? flattenAllFields({ cache: true, fields: collection.fields })
  const field = flattened.some((candidate) => {
    const marked = candidate as CheckboxField & { [retiredFieldMarker]?: unknown }
    return marked[retiredFieldMarker] === true && (marked.hooks?.beforeChange ?? []).includes(retirementBeforeChange)
  })
  if (!field) {
    return `durableRetirement requires retiredField() in the fields of ${collection.slug}.`
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
 * clears it through `retiredField()`'s hook. Returns the ids it marked.
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
 * from versions, so pruning `versions.maxPerDoc` cannot erase it. Wire `retiredField()` on every collection the lane
 * covers; this adapter refuses with a wiring error when the marked field or its hook is absent.
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
