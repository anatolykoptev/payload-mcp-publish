import type { CollectionBeforeChangeHook, CollectionSlug, Payload, PayloadRequest, SanitizedCollectionConfig } from 'payload'
import { APIError } from 'payload'
import { inferredRetirement, type RetirementAdapter } from './ownerUnpublished.js'

const retirementRefusal = (collection: string, id: number | string, publish: boolean) =>
  new APIError(
    `${collection} #${String(id)} was unpublished by the owner; ${publish ? 'nothing was published' : 'it cannot be edited from here'}. Republish or edit it in the admin.`,
    409,
    undefined,
    true,
  )

const wiringRefusal = (message: string) => new APIError(message, 500, undefined, true)

const checkRetirement = async (
  retirement: RetirementAdapter,
  payload: Payload,
  collection: SanitizedCollectionConfig,
  id: number | string,
  req: PayloadRequest,
  explicit: boolean,
) => {
  if (explicit) {
    const wiring = retirement.wiringProblem?.(collection)
    if (wiring) throw wiringRefusal(wiring)
  }
  return retirement.isRetired(payload, collection.slug as CollectionSlug, id, req)
}

/**
 * `beforeChange` for every collection the lane lists. Three jobs, all inside the write itself:
 *
 * 1. The `publishDraft` tool pins the draft the owner approved: it passes that draft's `updatedAt` as
 *    `context.publishPin`. The hook compares it with the draft the update is built on (`originalDoc`, the latest
 *    version), so a save that lands between the tool's check and the write is refused and nothing goes live. Without a
 *    pin (the admin, scripts) it does nothing.
 * 2. An MCP request never publishes: a create or update whose data says `_status: 'published'` is refused here, whatever
 *    the site's draft-only hook did or did not do. `publishDraft` is the only way, and it runs without the MCP request.
 * 3. An MCP request may not update a document the owner took down: saving drafts on it would push the evidence out of
 *    the version history. The lane's retirement adapter decides; without one, version-history inference is the fallback.
 */
export const makePublishPin = (retirement?: RetirementAdapter): CollectionBeforeChangeHook =>
  async function publishPinWithRetirement({ collection, context, data, operation, originalDoc, req }) {
    const decide = retirement ?? inferredRetirement
    const pin = (context as { publishPin?: number }).publishPin
    if (pin !== undefined) {
      if (!originalDoc || Date.parse(String(originalDoc.updatedAt)) !== pin) {
        throw new APIError('The draft changed while it was being published; nothing was published. Review it again.', 409, undefined, true)
      }
      const retired = await checkRetirement(
        decide,
        req.payload,
        collection,
        originalDoc.id as number | string,
        req,
        retirement !== undefined,
      )
      if (retired) throw retirementRefusal(collection.slug, originalDoc.id as number | string, true)
      return data
    }
    if ((req.payloadAPI as string) !== 'MCP') return data
    if ((data as { _status?: unknown } | undefined)?._status === 'published') {
      throw new APIError('An MCP write cannot publish. Save a draft, then use `publishDraft`.', 400, undefined, true)
    }
    if (operation === 'update' && originalDoc && (retirement !== undefined || originalDoc._status !== 'published')) {
      const retired = await checkRetirement(
        decide,
        req.payload,
        collection,
        originalDoc.id as number | string,
        req,
        retirement !== undefined,
      )
      if (retired) throw retirementRefusal(collection.slug, originalDoc.id as number | string, false)
    }
    return data
  }

/** The version-inference pin, exported for existing installations. New lanes should wire `lane.publishPin`. */
export const publishPin: CollectionBeforeChangeHook = makePublishPin()
