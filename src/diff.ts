import { createHash } from 'node:crypto'

/**
 * What the owner reads before approving a publish, and the digest that binds the approval.
 *
 * A document is flattened to its leaves (`path: value`): a string, number or boolean is one leaf, a
 * rich-text (Lexical) value is one leaf holding its whole text, an array contributes one path per row
 * (`items[2].label`). The dry run lists every leaf that differs between the live version and the draft
 * with BOTH values in full, never cut: a claim deep in a long body or in an array row is on the page the
 * owner approves. The digest covers the whole draft (and the live version it is shown against), so
 * nothing outside the diff can change either.
 */
type Doc = Record<string, unknown>

/** Keys the database owns; never part of a digest, a diff or the publishing write. */
const SYSTEM_KEYS = new Set(['_status', 'createdAt', 'id', 'updatedAt'])

const isRecord = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v)

const isLexical = (v: unknown): boolean => isRecord(v) && isRecord(v.root) && Array.isArray(v.root.children)

const BLOCK = new Set(['paragraph', 'heading', 'listitem', 'quote', 'code', 'horizontalrule', 'table', 'tablerow'])
/** Node types whose whole meaning is their text and children; any other node is rendered with its own payload. */
const PLAIN = new Set(['root', 'paragraph', 'heading', 'list', 'listitem', 'quote', 'text', 'linebreak', 'tab', 'link', 'autolink'])
/** Layout keys of a node: a change in them alone is "formatting", reported as such. */
const LAYOUT = new Set(['children', 'version', 'format', 'indent', 'direction', 'textFormat', 'textStyle', 'style'])

/**
 * The text of a Lexical node tree. Paragraphs are on their own lines, links are `text (url)`, headings carry their level,
 * and every other node (blocks, inline blocks, uploads, relationships) is rendered with its whole payload, so the content
 * those carry in `fields` / `value` is on the page the owner reads.
 */
const lexicalNode = (node: unknown): string => {
  if (!isRecord(node)) return ''
  const type = typeof node.type === 'string' ? node.type : ''
  if (type === 'tab') return '\t'
  if (typeof node.text === 'string') return node.text
  if (type === 'linebreak') return '\n'
  const inner = Array.isArray(node.children) ? node.children.map(lexicalNode).join('') : ''
  if (type === 'link' || type === 'autolink') {
    // An external link has a url; an internal one points at a document (`fields.doc`). Anything else a link carries is shown too.
    const { newTab: _newTab, ...fields } = (node.fields ?? {}) as Record<string, unknown>
    const url = typeof fields.url === 'string' ? fields.url : (node.url as string | undefined)
    if (url) return `${inner} (${url})`
    return Object.keys(fields).length ? `${inner} (${JSON.stringify(canonical(fields))})` : inner
  }
  if (type === 'heading') return `${'#'.repeat(Number(String(node.tag ?? 'h1').replace(/\D/g, '')) || 1)} ${inner}\n`
  if (!PLAIN.has(type)) {
    const payload = Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'type' && !LAYOUT.has(k)))
    return `[${type || 'node'} ${JSON.stringify(canonical(payload))}]${inner}${BLOCK.has(type) ? '\n' : ''}`
  }
  return BLOCK.has(type) ? `${inner}\n` : inner
}

/** The reader's view of a Lexical value: its text with embedded content, one block per line. */
export const lexicalText = (value: unknown): string => {
  const root = (value as { root?: { children?: unknown[] } }).root
  return (root?.children ?? []).map(lexicalNode).join('').replace(/\n+$/, '')
}

function canonical(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(canonical)
    : isRecord(v)
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v
}

const content = (doc: Doc): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => !SYSTEM_KEYS.has(k)))

/** What a digest binds besides the draft and the live version. */
export type DigestBinding = {
  collection: string
  /** What the gate will add to the publishing write. */
  gate: Record<string, unknown>
  id: number | string
}

/**
 * sha256 of the canonical JSON of what the owner saw: the draft, the live version it is read against, which document
 * this is, and what the site's gate will add to the write. Any of them changing changes the digest.
 */
export const contentDigest = (draft: Doc, live: Doc | undefined, bind: DigestBinding): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          collection: bind.collection,
          draft: content(draft),
          gate: bind.gate,
          id: String(bind.id),
          live: live ? content(live) : null,
        }),
      ),
    )
    .digest('hex')

/** True when a value holds no leaf at all (null, an empty list, a group of nulls). */
export const isEmptyValue = (v: unknown): boolean => {
  const out = new Map<string, Leaf>()
  leaves(v, 'x', out)
  return out.size === 0
}

type Leaf = { raw: string; shown: string }

const empty = (v: unknown) =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (isRecord(v) && !Object.keys(v).length)

const leaves = (value: unknown, path: string, out: Map<string, Leaf>): void => {
  if (empty(value)) return
  if (isLexical(value)) {
    out.set(path, { raw: JSON.stringify(canonical(value)), shown: JSON.stringify(lexicalText(value)) })
  } else if (Array.isArray(value)) {
    for (const [i, row] of value.entries()) leaves(row, `${path}[${i}]`, out)
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out)
  } else {
    const s = JSON.stringify(value)
    out.set(path, { raw: s, shown: s })
  }
}

const flatten = (doc: Doc | undefined): Map<string, Leaf> => {
  const out = new Map<string, Leaf>()
  if (doc) for (const [k, v] of Object.entries(content(doc))) leaves(v, k, out)
  return out
}

/**
 * One line per leaf that differs between the live version and the latest draft, both values in full.
 * Without a live version every leaf of the draft is listed. `skip` names top-level keys left out.
 */
export function diffSummary(live: Doc | undefined, latest: Doc, skip: ReadonlySet<string> = new Set()): string[] {
  const before = flatten(live)
  const after = flatten(latest)
  const top = (path: string) => path.split(/[.[]/, 1)[0] as string
  const lines: string[] = []
  for (const [path, a] of after) {
    if (skip.has(top(path))) continue
    const b = before.get(path)
    if (!b) lines.push(`  ${path}: ${live ? '(absent) -> ' : ''}${a.shown}`)
    else if (a.raw !== b.raw) {
      lines.push(
        a.shown === b.shown
          ? `  ${path}: formatting or structure changed (the text, links and embedded content are identical): ${a.shown}`
          : `  ${path}: ${b.shown} -> ${a.shown}`,
      )
    }
  }
  for (const [path, b] of before) if (!after.has(path) && !skip.has(top(path))) lines.push(`  ${path}: ${b.shown} -> (removed)`)
  return lines.length ? lines : ['  (no field differs)']
}

/**
 * Top-level fields of the published version that differ from the reviewed draft, after the write
 * (the publish gate's own fields are expected to differ and are skipped).
 */
export function mismatches(latest: Doc, published: Doc, skip: ReadonlySet<string> = new Set()): string[] {
  return Object.keys(latest).filter(
    (k) =>
      !SYSTEM_KEYS.has(k) &&
      !skip.has(k) &&
      JSON.stringify(canonical(latest[k] ?? null)) !== JSON.stringify(canonical(published[k] ?? null)),
  )
}
