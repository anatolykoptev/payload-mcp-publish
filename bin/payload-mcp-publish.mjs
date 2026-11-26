#!/usr/bin/env node
/**
 * payload-mcp-publish CLI. One command group: `claude-hook install|uninstall`, which sets up the Claude Code hook
 * that lets the owner approve `publishDraft` once per session (see the README, "Owner approval in Claude Code").
 * No dependencies.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_NAME } from '../claude/publish-grant-hook.mjs'

const HOOK_NAME = 'payload-mcp-publish-grant.mjs'
const CONFIG_NAME = 'payload-mcp-publish-grant.config.json'
const HOOK_SOURCE = fileURLToPath(new URL('../claude/publish-grant-hook.mjs', import.meta.url))
const DEFAULT_GRANT_DIR = '~/.claude/state/publish-grants'
const PUBLISH_MATCHER = `mcp__.*__${TOOL_NAME}`
// The permission-rule glob `mcp__*__publishDraft` (`*` is any run of characters).
const PUBLISH_ASK = new RegExp(`^mcp__.*__${TOOL_NAME}$`)
// An ask rule that covers a whole server or every MCP tool also covers publishDraft; it is reported, never removed.
const BROAD_ASK = /^mcp__([A-Za-z0-9_-]+|\*)(__\*)?$/

const USAGE = `Usage:
  payload-mcp-publish claude-hook install [--revoke <phrase>]... [--grant-dir <dir>] [--settings <path>] [--dry-run]
  payload-mcp-publish claude-hook uninstall [--settings <path>] [--dry-run]

Defaults: settings ~/.claude/settings.json (the hook is copied to a hooks/ folder next to it), revoke phrases
"publish-stop" and "stop publishing", grant dir ${DEFAULT_GRANT_DIR}. There are no grant phrases: the owner's Yes in the
permission dialog is the grant.`

const fail = (message) => {
  throw Object.assign(new Error(message), { cli: true })
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : resolve(p))

/** How a path is spelled in a Claude Code permission rule: `~/` under home, `//` for any other absolute path; always `/`. */
const ruleDir = (dir) => {
  const home = homedir()
  const posix = (p) => p.split(sep).join('/')
  if (dir === home || dir.startsWith(home + sep)) return `~/${posix(dir.slice(home.length + 1))}`.replace(/\/$/, '')
  return `/${posix(dir)}`
}

const parseArgs = (argv) => {
  const [group, action, ...rest] = argv
  if (group !== 'claude-hook' || (action !== 'install' && action !== 'uninstall')) fail(USAGE)
  const o = { action, revoke: [], dryRun: false }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const v = rest[++i]
      if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value`)
      return v
    }
    if (flag === '--dry-run') o.dryRun = true
    else if (flag === '--settings') o.settings = value()
    else if (action === 'install' && flag === '--grant')
      fail(
        "--grant is gone: a typed phrase cannot grant (UserPromptSubmit also fires for scheduled tasks and subagent reports). The owner's Yes in the permission dialog grants.",
      )
    else if (action === 'install' && flag === '--revoke') o.revoke.push(value())
    else if (action === 'install' && flag === '--grant-dir') o.grantDir = value()
    else fail(`unknown argument ${flag}\n${USAGE}`)
  }
  for (const p of o.revoke) if (p.trim() === '') fail('a phrase may not be blank: it would match every prompt')
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
  if (!existsSync(path)) return { settings: {}, indent: '  ', eol: '\n', existed: false, raw: null }
  const { value, raw } = readJson(path, 'settings file')
  return { settings: value, indent: raw.match(/^([ \t]+)"/m)?.[1] ?? '  ', eol: raw.endsWith('\n') ? '\n' : '', existed: true, raw }
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

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']

const desiredGroup = (hookPath, event) => {
  // PreToolUse fails closed: `|| exit 2` blocks the call, and `onFailure: "block"` (Claude Code >= 2.1.295, see the hooks
  // reference, "Block the action when a hook fails") also blocks on a timeout or a hook that cannot start. The other
  // events fail open: a crash never blocks the owner's prompt or a finished call.
  const pre = event === 'PreToolUse'
  const hook = { type: 'command', command: `node "${hookPath}" || exit ${pre ? 2 : 0}`, ...(pre ? { onFailure: 'block' } : {}) }
  return event === 'UserPromptSubmit' ? { hooks: [hook] } : { matcher: PUBLISH_MATCHER, hooks: [hook] }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Adds our hook groups, leaving them in place when they are already exactly right. */
const addHooks = (settings, hookPath, changes) => {
  settings.hooks ??= {}
  for (const event of EVENTS) {
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
  for (const event of EVENTS) {
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

/** Writes settings through a temp file and a rename, refusing if the file changed since it was read. */
const writeSettings = (path, before, after) => {
  const target = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(target), { recursive: true })
  const unchanged = () => (existsSync(target) ? readFileSync(target, 'utf8') : null) === before.raw
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, render(after), { mode: before.existed ? statSync(target).mode & 0o777 : 0o600 })
  if (!unchanged()) {
    rmSync(tmp, { force: true })
    fail(`${target} changed while the installer was running; nothing was written. Run the command again.`)
  }
  let backup = null
  if (before.existed) {
    backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(target, backup)
  }
  renameSync(tmp, target)
  return backup
}

const askRulesOf = (settings) =>
  Array.isArray(settings?.permissions?.ask) ? settings.permissions.ask.filter((r) => typeof r === 'string') : []

/** Project settings in the current directory that still hold ask rules covering publishDraft (they would beat the grant). */
const projectAskWarnings = (settingsPath) => {
  const out = []
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = resolve('.claude', name)
    if (file === settingsPath || !existsSync(file)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const hits = askRulesOf(parsed).filter((r) => PUBLISH_ASK.test(r) || BROAD_ASK.test(r))
    if (hits.length)
      out.push(
        `Warning: ${file} holds permissions.ask ${hits.join(', ')}. It beats the grant; remove it there (install only edits ${settingsPath}).`,
      )
  }
  return out
}

/**
 * A PermissionRequest hook whose matcher covers publishDraft can answer the first prompt instead of the owner, and that
 * answer grants the session. The matcher is an exact tool name or a regular expression; none, "" and "*" match every tool.
 */
const permissionRequestWarnings = (settings) => {
  const sample = `mcp__server__${TOOL_NAME}`
  const matches = (matcher) => {
    if (matcher === undefined || matcher === '' || matcher === '*') return true
    try {
      return new RegExp(`^(?:${matcher})$`).test(sample)
    } catch {
      return false
    }
  }
  const groups = Array.isArray(settings.hooks?.PermissionRequest) ? settings.hooks.PermissionRequest : []
  return groups
    .filter((g) => matches(g?.matcher))
    .map(
      (g) =>
        `Warning: a PermissionRequest hook (matcher ${JSON.stringify(g?.matcher ?? '')}) matches ${TOOL_NAME}. If it answers the first prompt, that answer grants the session; it must be the owner's decision.`,
    )
}

const dropEmptyPermissions = (settings) => {
  if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions
}

const install = (o) => {
  const settingsPath = resolve(o.settings ?? join(homedir(), '.claude', 'settings.json'))
  const hooksDir = join(dirname(settingsPath), 'hooks')
  const hookPath = join(hooksDir, HOOK_NAME)
  const configPath = join(hooksDir, CONFIG_NAME)
  const previous = existsSync(configPath) ? readJson(configPath, 'hook config').value : {}
  const grantDirSpec = o.grantDir ?? previous.grantDir ?? DEFAULT_GRANT_DIR
  const grantDir = expandHome(grantDirSpec)
  const config = {
    revokePhrases: o.revoke.length ? o.revoke : (previous.revokePhrases ?? ['publish-stop', 'stop publishing']),
    maxAgeSeconds: previous.maxAgeSeconds ?? 24 * 3600,
    grantDir: grantDirSpec,
  }

  const before = readSettings(settingsPath)
  const settings = structuredClone(before.settings)
  const changes = []
  addHooks(settings, hookPath, changes)

  settings.permissions ??= {}
  const ask = askRulesOf(settings)
  const askRemoved = ask.filter((r) => PUBLISH_ASK.test(r))
  if (askRemoved.length) {
    const keep = settings.permissions.ask.filter((r) => !askRemoved.includes(r))
    if (keep.length) settings.permissions.ask = keep
    else delete settings.permissions.ask
    changes.push(`removed permissions.ask: ${askRemoved.join(', ')}`)
  }
  const broad = ask.filter((r) => BROAD_ASK.test(r) && !PUBLISH_ASK.test(r))

  // Only Edit rules: a Write(path) deny rule is inert (the permissions reference matches file rules against the Edit tool
  // family). The grant directory is denied to the agent, and so are the installed hook and its config.
  const deny = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : []
  const rules = [`Edit(${ruleDir(grantDir)}/**)`, `Edit(${ruleDir(hooksDir)}/${HOOK_NAME.replace(/\.mjs$/, '')}*)`]
  const denyAdded = rules.filter((r) => !deny.includes(r))
  if (denyAdded.length) {
    settings.permissions.deny = [...deny, ...denyAdded]
    changes.push(`added permissions.deny: ${denyAdded.join(', ')}`)
  }
  dropEmptyPermissions(settings)

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
    mkdirSync(hooksDir, { recursive: true })
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
  out.push(...permissionRequestWarnings(settings), ...projectAskWarnings(settingsPath))
  out.push(
    `Grant: the owner's Yes in the permission dialog for one publishDraft call. Revoke phrases: ${config.revokePhrases.join(', ')}. State: ${grantDir}`,
  )
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
    changes.push(`removed permissions.deny: ${gone.join(', ')}`)
  }
  // Put back the per-call approval that install removed (deduplicated).
  const removedAsk = Array.isArray(installed.askRemoved) ? installed.askRemoved.filter((r) => typeof r === 'string') : []
  const ask = askRulesOf(settings)
  const restore = removedAsk.filter((r) => !ask.includes(r))
  if (restore.length) {
    settings.permissions ??= {}
    settings.permissions.ask = [...ask, ...restore]
    changes.push(`restored permissions.ask: ${restore.join(', ')}`)
  }
  dropEmptyPermissions(settings)

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
  if (!hadRecord) out.push('No install record found; the deny rules were left alone.')
  return out.join('\n')
}

const main = () => {
  try {
    const o = parseArgs(process.argv.slice(2))
    console.log(o.action === 'install' ? install(o) : uninstall(o))
  } catch (e) {
    console.error(e.cli ? e.message : `payload-mcp-publish: ${e.stack ?? e}`)
    process.exitCode = 1
  }
}

export { readSettings, writeSettings }

// Run only as a script (the tests import the two functions above).
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main()
