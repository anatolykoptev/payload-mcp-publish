import type { CollectionSlug, Field, Payload } from 'payload'
import { publishPin } from './pin.js'

const localized = (fields: Field[] | undefined): boolean =>
  (fields ?? []).some((f) => {
    const any = f as unknown as {
      blocks?: { fields: Field[] }[]
      fields?: Field[]
      localized?: boolean
      tabs?: { fields: Field[]; localized?: boolean }[]
    }
    return (
      any.localized === true ||
      localized(any.fields) ||
      (any.blocks ?? []).some((b) => localized(b.fields)) ||
      (any.tabs ?? []).some((t) => t.localized === true || localized(t.fields))
    )
  })

/**
 * Why the lane cannot safely publish this collection, or `undefined`. Checked on every call, because a lane that is
 * only half wired fails open: without the hook nothing pins the reviewed draft, without drafts there is no draft, and
 * with localized fields the diff and the digest would cover one locale of several.
 */
export const wiringProblem = (payload: Payload, collection: string): string | undefined => {
  const config = payload.collections[collection as CollectionSlug]?.config
  if (!config) return `\`${collection}\` is not a collection of this site.`
  if (!config.versions?.drafts) return `${collection} has no drafts (\`versions.drafts\`), so there is nothing to publish.`
  const before = (config.hooks?.beforeChange ?? []) as unknown[]
  if (!before.includes(publishPin)) {
    return `${collection} is not wired: add \`lane.publishPin\` to its \`hooks.beforeChange\`. Nothing would pin the reviewed draft.`
  }
  if (payload.config.localization && localized(config.fields)) {
    return `${collection} has localized fields; the lane reviews one locale and would publish all of them. Publish it in the admin.`
  }
  return undefined
}
