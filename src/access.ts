import type { Access, CollectionSlug } from 'payload'
import { ownerUnpublishedIds } from './ownerUnpublished.js'

const CACHE = 'mcpPublishRetired'

/**
 * Read access for a collection whose retired documents an MCP key must not see. An MCP key reads the latest drafts (it
 * writes them), but not a document the owner took down (or whose history is too pruned to tell): that row is a retired
 * claim, and listing it beside the real ones invites an agent to describe or relink it. Everyone else gets `base`
 * unchanged. Wrap the collection's own `read` with it. The ids are looked up once per request.
 */
export const hideOwnerUnpublishedFromMcp =
  (collection: CollectionSlug, base: Access): Access =>
  async (args) => {
    const allowed = await base(args)
    if ((args.req.payloadAPI as string) !== 'MCP' || allowed === false) return allowed
    args.req.context = args.req.context ?? {}
    const ctx = args.req.context as Record<string, Promise<(number | string)[]> | undefined>
    const key = `${CACHE}:${collection}`
    ctx[key] = ctx[key] ?? ownerUnpublishedIds(args.req.payload, collection)
    const retired = await ctx[key]
    if (!retired?.length) return allowed
    const hide = { id: { not_in: retired } }
    return allowed === true ? hide : { and: [allowed, hide] }
  }
