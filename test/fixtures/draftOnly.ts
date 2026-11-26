import type { CollectionBeforeOperationHook } from 'payload'

/**
 * Stands in for a site's own draft-only hook (the lane does not ship one: each site's copy differs).
 * For an MCP request every create and update is a draft and reads return the latest draft; the lane's
 * own publish call runs without `req`, so this hook never sees it.
 */
export const draftOnly: CollectionBeforeOperationHook<any> = ({ args, operation, req }) => {
  if ((req.payloadAPI as string) !== 'MCP') return args
  if (operation === 'create' || operation === 'update') {
    const data = (args as { data?: unknown }).data
    return { ...args, data: data && typeof data === 'object' ? { ...data, _status: 'draft' } : data, draft: true }
  }
  if (operation === 'read' && (args as { overrideAccess?: unknown }).overrideAccess === false) return { ...args, draft: true }
  return args
}
