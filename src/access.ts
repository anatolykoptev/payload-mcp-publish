import type { Access, CollectionSlug } from 'payload'
import { inferredRetirement, type RetirementAdapter } from './ownerUnpublished.js'

type RetiredCache = Map<string, Promise<(number | string)[]>>

/** Make read access for a collection whose retired documents an MCP key must not see. */
export const makeHideOwnerUnpublishedFromMcp = (retirement: RetirementAdapter = inferredRetirement) => {
  // A symbol per helper instance: two lanes (or the legacy helper beside a lane) can never share a stale id list.
  const cacheKey = Symbol('mcpPublishRetired')
  return (collection: CollectionSlug, base: Access): Access =>
    async (args) => {
      const allowed = await base(args)
      if ((args.req.payloadAPI as string) !== 'MCP' || allowed === false) return allowed
      args.req.context = args.req.context ?? {}
      const context = args.req.context as Record<PropertyKey, unknown>
      let cache = context[cacheKey] as RetiredCache | undefined
      if (!cache) {
        cache = new Map()
        context[cacheKey] = cache
      }
      let retired = cache.get(collection)
      if (!retired) {
        retired = retirement.retiredIds(args.req.payload, collection, args.req)
        cache.set(collection, retired)
      }
      const ids = await retired
      if (!ids.length) return allowed
      const hide = { id: { not_in: ids } }
      return allowed === true ? hide : { and: [allowed, hide] }
    }
}

/**
 * Read access for a collection whose retired documents an MCP key must not see, using version-history inference.
 * An MCP key reads the latest drafts (it writes them), but not a document the owner took down: that row is a retired
 * claim, and listing it beside the real ones invites an agent to describe or relink it. Everyone else gets `base`
 * unchanged. Wrap the collection's own `read` with it. The ids are looked up once per request.
 *
 * Kept for existing installations. A lane configured with a retirement adapter exposes the matching closure as
 * `lane.hideOwnerUnpublishedFromMcp`; use that one.
 */
export const hideOwnerUnpublishedFromMcp = makeHideOwnerUnpublishedFromMcp()
