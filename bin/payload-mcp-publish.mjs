#!/usr/bin/env node
/**
 * payload-mcp-publish CLI. One command group: `claude-hook install|uninstall`, which sets up the Claude Code hook
 * that lets the owner approve `publishDraft` once per session (see the README, "Owner approval in Claude Code").
 * No dependencies.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK_NAME = 'payload-mcp-publish-grant.mjs'
const CONFIG_NAME = 'payload-mcp-publish-grant.config.json'
const HOOK_SOURCE = fileURLToPath(new URL('../claude/publish-grant-hook.mjs', import.meta.url))
const DEFAULT_GRANT_DIR = '~/.claude/state/publish-grants'
const PUBLISH_MATCHER = 'mcp__.*__publishDraft'
// The permission-rule glob `mcp__*__publishDraft` (`*` is any run of characters).
const PUBLISH_ASK = /^mcp__.*__publishDraft$/
// An ask rule that covers a whole server or every MCP tool also covers publishDraft; it is reported, never removed.
const BROAD_ASK = /^mcp__([A-Za-z0-9_-]+|\*)(__\*)?$/

const USAGE = `Usage:
  payload-mcp-publish claude-hook install [--grant <phrase>]... [--revoke <phrase>]... [--grant-dir <dir>] [--settings <path>] [--dry-run]
  payload-mcp-publish claude-hook uninstall [--settings <path>] [--dry-run]

Defaults: settings ~/.claude/settings.json (the hook is copied to a hooks/ folder next to it), grant phrases
"publish-ok" and "allow publishing", revoke phrases "publish-stop" and "stop publishing", grant dir ${DEFAULT_GRANT_DIR}.`

const fail = (message) => {
  throw Object.assign(new Error(message), { cli: true })
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : resolve(p))

/** How a path is spelled in a Claude Code permission rule: `~/` under home, `//` for any other absolute path. */
const ruleDir = (dir) => {
  const home = homedir()
  if (dir === home || dir.startsWith(home + sep)) return `~/${dir.slice(home.length + 1)}`.replace(/\/$/, '')
  return `/${dir}`
}

const parseArgs = (argv) => {
  const [group, action, ...rest] = argv
  if (group !== 'claude-hook' || (action !== 'install' && action !== 'uninstall')) fail(USAGE)
  const o = { action, grant: [], revoke: [], dryRun: false }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const v = rest[++i]
      if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value`)
      return v
    }
    if (flag === '--dry-run') o.dryRun = true
    else if (flag === '--settings') o.settings = value()
    else if (action === 'install' && flag === '--grant') o.grant.push(value())
    else if (action === 'install' && flag === '--revoke') o.revoke.push(value())
    else if (action === 'install' && flag === '--grant-dir') o.grantDir = value()
    else fail(`unknown argument ${flag}\n${USAGE}`)
  }
  for (const p of [...o.grant, ...o.revoke]) if (p.trim() === '') fail('a phrase may not be blank: it would match every prompt')
  return o
}

const readJson = (path, what) => {
  const raw = readFileSync(path, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch (e) {
    return fail(`${what} ${path} is not valid JSON (${e.message}); nothing was changed`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${what} ${path} is not a JSON object`)
  return { value, raw }
}

const readSettings = (path) => {
  if (!existsSync(path)) return { settings: {}, indent: '  ', eol: '\n', existed: false }
  const { value, raw } = readJson(path, 'settings file')
  return { settings: value, indent: raw.match(/^([ \t]+)"/m)?.[1] ?? '  ', eol: raw.endsWith('\n') ? '\n' : '', existed: true }
}

const render = (s) => `${JSON.stringify(s.settings, null, s.indent)}${s.eol}`

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(HOOK_NAME)

/** Removes our hook entries from one event's groups; groups that held only ours go, others stay untouched. */
const withoutOurs = (groups) =>
  groups.flatMap((g) => {
    const hooks = Array.isArray(g?.hooks) ? g.hooks : []
    const kept = hooks.filter((h) => !isOurs(h))
    if (kept.length === hooks.length) return [g]
    return kept.length > 0 ? [{ ...g, hooks: kept }] : []
  })

const ourGroups = (groups) => groups.filter((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs))

const desiredGroup = (hookPath, event) => {
  // UserPromptSubmit fails open (a crash must not block the owner's prompt); PreToolUse fails closed (exit 2 blocks the call).
  const suffix = event === 'PreToolUse' ? 'exit 2' : 'exit 0'
  const group = { hooks: [{ type: 'command', command: `node "${hookPath}" || ${suffix}` }] }
  return event === 'PreToolUse' ? { matcher: PUBLISH_MATCHER, ...group } : group
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Adds our two hook groups, leaving them in place when they are already exactly right. */
const addHooks = (settings, hookPath, changes) => {
  settings.hooks ??= {}
  for (const event of ['UserPromptSubmit', 'PreToolUse']) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const want = desiredGroup(hookPath, event)
    const have = ourGroups(groups)
    if (have.length === 1 && same(have[0], want)) {
      settings.hooks[event] = groups
      continue
    }
    settings.hooks[event] = [...withoutOurs(groups), want]
    changes.push(`${have.length ? 'updated' : 'added'} hooks.${event}: ${want.hooks[0].command}`)
  }
}

const removeHooks = (settings, changes) => {
  if (!settings.hooks) return
  for (const event of ['UserPromptSubmit', 'PreToolUse']) {
    const groups = settings.hooks[event]
    if (!Array.isArray(groups) || ourGroups(groups).length === 0) continue
    const kept = withoutOurs(groups)
    if (kept.length > 0) settings.hooks[event] = kept
    else delete settings.hooks[event]
    changes.push(`removed hooks.${event} entry for ${HOOK_NAME}`)
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
}

/** Line diff (LCS) of two renderings, printed as unified hunks with 2 lines of context. */
const lineDiff = (before, after) => {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i++]])
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push(['-', a[i++]])
    else ops.push(['+', b[j++]])
  }
  while (i < a.length) ops.push(['-', a[i++]])
  while (j < b.length) ops.push(['+', b[j++]])
  const show = ops.map((_, k) => ops.slice(Math.max(0, k - 2), k + 3).some(([t]) => t !== ' '))
  const out = []
  let gap = false
  ops.forEach(([t, line], k) => {
    if (!show[k]) {
      gap = true
      return
    }
    if (gap && out.length) out.push('  ...')
    gap = false
    out.push(`${t} ${line}`)
  })
  return out.join('\n')
}

const writeSettings = (path, before, after) => {
  const next = render(after)
  mkdirSync(dirname(path), { recursive: true })
  let backup = null
  if (before.existed) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(path, backup)
  }
  writeFileSync(path, next)
  return backup
}

const install = (o) => {
  const settingsPath = resolve(o.settings ?? join(homedir(), '.claude', 'settings.json'))
  const claudeDir = dirname(settingsPath)
  const hookPath = join(claudeDir, 'hooks', HOOK_NAME)
  const configPath = join(claudeDir, 'hooks', CONFIG_NAME)
  const previous = existsSync(configPath) ? readJson(configPath, 'hook config').value : {}
  const grantDirSpec = o.grantDir ?? previous.grantDir ?? DEFAULT_GRANT_DIR
  const grantDir = expandHome(grantDirSpec)
  const config = {
    grantPhrases: o.grant.length ? o.grant : (previous.grantPhrases ?? ['publish-ok', 'allow publishing']),
    revokePhrases: o.revoke.length ? o.revoke : (previous.revokePhrases ?? ['publish-stop', 'stop publishing']),
    maxAgeSeconds: previous.maxAgeSeconds ?? 24 * 3600,
    grantDir: grantDirSpec,
  }

  const before = readSettings(settingsPath)
  const settings = structuredClone(before.settings)
  const changes = []
  addHooks(settings, hookPath, changes)

  settings.permissions ??= {}
  const ask = Array.isArray(settings.permissions.ask) ? settings.permissions.ask : []
  const askRemoved = ask.filter((r) => typeof r === 'string' && PUBLISH_ASK.test(r))
  if (askRemoved.length) {
    const keep = ask.filter((r) => !askRemoved.includes(r))
    if (keep.length) settings.permissions.ask = keep
    else delete settings.permissions.ask
    changes.push(`removed permissions.ask: ${askRemoved.join(', ')}`)
  }
  const broad = ask.filter((r) => typeof r === 'string' && BROAD_ASK.test(r) && !PUBLISH_ASK.test(r))

  const deny = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : []
  const rules = ['Write', 'Edit'].map((tool) => `${tool}(${ruleDir(grantDir)}/**)`)
  const denyAdded = rules.filter((r) => !deny.includes(r))
  if (denyAdded.length) {
    settings.permissions.deny = [...deny, ...denyAdded]
    changes.push(`added permissions.deny: ${denyAdded.join(', ')}`)
  }
  if (Object.keys(settings.permissions).length === 0) delete settings.permissions

  // What uninstall reverses: accumulated across reruns, so a second install does not forget the first one's additions.
  config.installed = {
    deny: [...new Set([...(previous.installed?.deny ?? []), ...denyAdded])],
    askRemoved: [...new Set([...(previous.installed?.askRemoved ?? []), ...askRemoved])],
  }

  const after = { ...before, settings }
  const out = []
  if (o.dryRun) out.push('Dry run: nothing was written.')
  const diff = lineDiff(before.existed ? render(before) : '', render(after))
  if (changes.length === 0) out.push('Settings already up to date; nothing to change.')
  else out.push(...changes.map((c) => `- ${c}`), '', `Diff of ${settingsPath}:`, diff)
  if (!o.dryRun) {
    mkdirSync(dirname(hookPath), { recursive: true })
    copyFileSync(HOOK_SOURCE, hookPath)
    chmodSync(hookPath, 0o644)
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    const backup = changes.length ? writeSettings(settingsPath, before, after) : null
    out.push(`Hook: ${hookPath}`, `Config: ${configPath}`)
    if (backup) out.push(`Backup: ${backup}`)
  } else out.push(`Would copy the hook to ${hookPath} and write ${configPath}.`)
  if (askRemoved.length) out.push(`To restore the per-call approval, put back under permissions.ask: ${askRemoved.join(', ')}`)
  if (broad.length)
    out.push(
      `Warning: permissions.ask also holds ${broad.join(', ')}. An ask rule beats a hook "allow", so it keeps prompting on publishDraft; remove it for the session grant to work.`,
    )
  out.push(`Grant phrases: ${config.grantPhrases.join(', ')}. Revoke phrases: ${config.revokePhrases.join(', ')}. Grants: ${grantDir}`)
  return out.join('\n')
}

const uninstall = (o) => {
  const settingsPath = resolve(o.settings ?? join(homedir(), '.claude', 'settings.json'))
  const hooksDir = join(dirname(settingsPath), 'hooks')
  const hookPath = join(hooksDir, HOOK_NAME)
  const configPath = join(hooksDir, CONFIG_NAME)
  const hadRecord = existsSync(configPath)
  const installed = hadRecord ? (readJson(configPath, 'hook config').value.installed ?? {}) : {}

  const before = readSettings(settingsPath)
  const settings = structuredClone(before.settings)
  const changes = []
  removeHooks(settings, changes)
  const added = Array.isArray(installed.deny) ? installed.deny : []
  const deny = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : []
  const gone = added.filter((r) => deny.includes(r))
  if (gone.length) {
    const keep = deny.filter((r) => !gone.includes(r))
    if (keep.length) settings.permissions.deny = keep
    else delete settings.permissions.deny
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions
    changes.push(`removed permissions.deny: ${gone.join(', ')}`)
  }

  const out = []
  if (o.dryRun) out.push('Dry run: nothing was written.')
  const after = { ...before, settings }
  if (changes.length === 0) out.push('Nothing to remove from the settings.')
  else out.push(...changes.map((c) => `- ${c}`), '', `Diff of ${settingsPath}:`, lineDiff(render(before), render(after)))
  if (!o.dryRun) {
    const backup = changes.length ? writeSettings(settingsPath, before, after) : null
    rmSync(hookPath, { force: true })
    rmSync(configPath, { force: true })
    if (backup) out.push(`Backup: ${backup}`)
    out.push(`Removed ${hookPath} and ${configPath}.`)
  }
  if (Array.isArray(installed.askRemoved) && installed.askRemoved.length)
    out.push(`Install removed these permissions.ask entries; put them back to approve each call again: ${installed.askRemoved.join(', ')}`)
  if (!hadRecord) out.push('No install record found; the deny rules were left alone.')
  return out.join('\n')
}

try {
  const o = parseArgs(process.argv.slice(2))
  console.log(o.action === 'install' ? install(o) : uninstall(o))
} catch (e) {
  console.error(e.cli ? e.message : `payload-mcp-publish: ${e.stack ?? e}`)
  process.exitCode = 1
}
