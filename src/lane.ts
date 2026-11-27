import type { Access, CollectionConfig, CollectionSlug, Field, PayloadRequest } from 'payload'
import type { z } from 'zod'
import { hideOwnerUnpublishedFromMcp, makeHideOwnerUnpublishedFromMcp } from './access.js'
import { makePublishPin, publishPin } from './pin.js'
import { makePublishDraft, type PublishToolOptions, publishDraftDescription, publishDraftParameters } from './tool.js'

const RESERVED = new Set(['collection', 'digest', 'dryRun', 'id'])

export type PublishLaneOptions = PublishToolOptions

/** A custom tool in the shape `@payloadcms/plugin-mcp` 3 takes under `mcp.tools`. */
export type PublishDraftTool = {
  description: string
  handler: (args: Record<string, unknown>, req: PayloadRequest) => Promise<{ content: { text: string; type: 'text' }[] }>
  name: 'publishDraft'
  parameters: z.ZodRawShape
}

export type PublishLane = {
  /** Add this to `mcp.tools`. */
  tool: PublishDraftTool
  /**
   * Read access hiding owner-retired documents from MCP reads, using the lane's retirement adapter.
   * Wrap the collection's own `read` access with it. Without an adapter it is the exported inference helper.
   */
  hideOwnerUnpublishedFromMcp: (collection: CollectionSlug, base: Access) => Access
  /** Add this to `hooks.beforeChange` of every listed collection. */
  publishPin: typeof publishPin
  /**
   * `overrideAuth` for `mcpPlugin`: stashes the key's resolved permissions on `req.context.mcpAccess`,
   * where the tool reads the key's own update boxes. Pass your own `overrideAuth` as `inner` to keep it.
   */
  overrideAuth: <R extends object>(
    inner?: (req: PayloadRequest, getDefault: (overrideApiKey?: null | string) => Promise<R>) => R | Promise<R>,
  ) => (req: PayloadRequest, getDefault: (overrideApiKey?: null | string) => Promise<R>) => Promise<R>
  /**
   * For `overrideApiKeyCollection`: the checkboxes of these custom tools start unticked (the plugin
   * registers them ticked). `publishDraft` is always included; pass the names of your other tools
   * that must be granted per key (`ogCard`, `uploadMedia`, ...).
   */
  offByDefault: (collection: CollectionConfig, more?: Iterable<string>) => CollectionConfig
}

/** The custom tool checkboxes a key must be granted: the plugin registers them default-on. */
export const offByDefault = (collection: CollectionConfig, names: ReadonlySet<string>): CollectionConfig => {
  const visit = (fields: Field[]): Field[] =>
    fields.map((field) => {
      if ('name' in field && field.name === 'payload-mcp-tool' && 'fields' in field) {
        return {
          ...field,
          fields: visit(field.fields).map((inner) =>
            'name' in inner && names.has(inner.name as string) && inner.type === 'checkbox' ? { ...inner, defaultValue: false } : inner,
          ),
        } as Field
      }
      return 'fields' in field && field.fields ? ({ ...field, fields: visit(field.fields) } as Field) : field
    })
  return { ...collection, fields: visit(collection.fields) }
}

/**
 * The publish lane for `@payloadcms/plugin-mcp` 3: an agent writes drafts over MCP, and one reviewed
 * draft at a time goes live through `publishDraft` after the owner has seen its diff. See README.md.
 */
export function mcpPublishLane(options: PublishLaneOptions): PublishLane {
  if (!options.collections.length) throw new Error('mcpPublishLane: `collections` must list at least one collection.')
  const collections = [...new Set(options.collections)]
  const taken = Object.keys(options.gate?.parameters ?? {}).filter((k) => RESERVED.has(k))
  if (taken.length) throw new Error(`mcpPublishLane: gate parameters may not reuse the tool's own names (${taken.join(', ')}).`)
  if (options.retirement && (typeof options.retirement.isRetired !== 'function' || typeof options.retirement.retiredIds !== 'function')) {
    throw new Error('mcpPublishLane: `retirement` must implement both `isRetired` and `retiredIds`.')
  }
  const o = { ...options, collections }
  const pin = options.retirement ? makePublishPin(options.retirement) : publishPin
  const hide = options.retirement ? makeHideOwnerUnpublishedFromMcp(options.retirement) : hideOwnerUnpublishedFromMcp
  return {
    hideOwnerUnpublishedFromMcp: hide,
    offByDefault: (collection, more = []) => offByDefault(collection, new Set(['publishDraft', ...more])),
    overrideAuth: (inner) => async (req, getDefault) => {
      // What the plugin uses is what this returns, so that is what the tool must read: a site's own override may narrow it.
      const resolved = await (inner ? inner(req, getDefault) : getDefault())
      req.context = req.context ?? {}
      req.context.mcpAccess = resolved
      return resolved
    },
    publishPin: pin,
    tool: {
      description: publishDraftDescription,
      handler: makePublishDraft(o, pin),
      name: 'publishDraft',
      parameters: publishDraftParameters(o),
    },
  }
}
