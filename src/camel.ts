/** The plugin's own `toCamelCase`: a collection slug becomes the name of its permission group on an API key. */
export const camel = (slug: string): string =>
  slug.replace(/[-_\s]+(.)?/g, (_, c: string) => (c ? c.toUpperCase() : '')).replace(/^(.)/, (_, c: string) => c.toLowerCase())
