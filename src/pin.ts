import type { CollectionBeforeChangeHook } from 'payload'
import { APIError } from 'payload'
import { standingOf } from './ownerUnpublished.js'

/**
 * `beforeChange` for every collection the lane lists. Three jobs, all inside the write itself:
 *
 * 1. The `publishDraft` tool pins the draft the owner approved: it passes that draft's `updatedAt` as
 *    `context.publishPin`. The hook compares it with the draft the update is built on (`originalDoc`, the latest
 *    version), so a save that lands between the tool's check and the write is refused and nothing goes live. Without a
 *    pin (the admin, scripts) it does nothing.
 * 2. An MCP request never publishes: a create or update whose data says `_status: 'published'` is refused here, whatever
 *    the site's draft-only hook did or did not do. `publishDraft` is the only way, and it runs without the MCP request.
 * 3. An MCP request may not update a document the owner took down (see
 *    `standingOf`): saving drafts on it would push the evidence out of the version history.
 */
export const publishPin: CollectionBeforeChangeHook = async ({ collection, context, data, operation, originalDoc, req }) => {
  const pin = (context as { publishPin?: number }).publishPin
  if (pin !== undefined) {
    if (!originalDoc || Date.parse(String(originalDoc.updatedAt)) !== pin) {
      throw new APIError('The draft changed while it was being published; nothing was published. Review it again.', 409, undefined, true)
    }
    return data
  }
  if ((req.payloadAPI as string) !== 'MCP') return data
  if ((data as { _status?: unknown } | undefined)?._status === 'published') {
    throw new APIError('An MCP write cannot publish. Save a draft, then use `publishDraft`.', 400, undefined, true)
  }
  if (operation === 'update' && originalDoc && originalDoc._status !== 'published') {
    const standing = await standingOf(req.payload, collection.slug as never, originalDoc.id as number | string, req)
    if (standing === 'retired') {
      throw new APIError(
        `${collection.slug} #${String(originalDoc.id)} was unpublished by the owner; it cannot be edited from here. Republish or edit it in the admin.`,
        409,
        undefined,
        true,
      )
    }
  }
  return data
}
