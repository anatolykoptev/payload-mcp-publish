#!/usr/bin/env node
/**
 * Claude Code hook: the owner approves `publishDraft` once per session, by saying Yes in the permission dialog.
 *
 * PreToolUse on `mcp__<server>__publishDraft`: a fresh grant for this session answers "allow". Otherwise the hook
 *   records the call's `tool_use_id` as pending and answers "ask", so the owner gets the permission dialog.
 * PostToolUse on the same tools: the call ran, so the owner said Yes in that dialog. Only if its `tool_use_id` is
 *   the pending one this hook asked about, and the session was not in a mode where nobody answers
 *   (bypassPermissions, dontAsk), the session is granted. (In `auto` mode the hook's "ask" still reaches the human.)
 * UserPromptSubmit: a revoke phrase deletes the grant. A prompt never GRANTS: that event also fires for scheduled
 *   tasks, /loop, a background subagent's report and messages from other sessions, so typed text is not proof of
 *   the owner.
 *
 * Reads the hook event as JSON on stdin; unreadable input exits 1 (the registered command turns that into a block on
 * PreToolUse and a no-op elsewhere). Configuration, in order of precedence: the environment (PUBLISH_GRANT_DIR,
 * PUBLISH_GRANT_MAX_AGE in seconds, PUBLISH_GRANT_CONFIG for the config path), then the sibling JSON file
 * (`<this file without .mjs>.config.json`: revokePhrases, maxAgeSeconds, grantDir), then the defaults below. A config
 * file that exists but is invalid throws, which fails the same way.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The tool this hook guards; the installer builds its matcher and the ask-rule filter from it. */
export const TOOL_NAME = 'publishDraft'
const PUBLISH_TOOL = new RegExp(`^mcp__[A-Za-z0-9_-]+__${TOOL_NAME}$`)

const DEFAULTS = {
  revokePhrases: ['publish-stop', 'stop publishing'],
  maxAgeSeconds: 24 * 3600,
  grantDir: '~/.claude/state/publish-grants',
}
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,200}$/
const NOBODY_ANSWERS = new Set(['bypassPermissions', 'dontAsk'])

const phraseList = (value, name) => {
  if (!Array.isArray(value) || value.length === 0 || value.some((p) => typeof p !== 'string' || p.trim() === ''))
    throw new Error(`${name} must be a non-empty array of non-blank strings`)
  return value.map((p) => p.toLowerCase())
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)

const loadConfig = () => {
  const path = process.env.PUBLISH_GRANT_CONFIG || fileURLToPath(import.meta.url).replace(/\.mjs$/, '.config.json')
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  if (file === null || typeof file !== 'object' || Array.isArray(file)) throw new Error('config must be a JSON object')
  const merged = { ...DEFAULTS, ...file }
  let maxAgeSeconds = merged.maxAgeSeconds
  if (process.env.PUBLISH_GRANT_MAX_AGE) maxAgeSeconds = Number(process.env.PUBLISH_GRANT_MAX_AGE)
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('maxAgeSeconds must be a positive number')
  const grantDir = process.env.PUBLISH_GRANT_DIR || merged.grantDir
  if (typeof grantDir !== 'string' || grantDir.trim() === '') throw new Error('grantDir must be a non-empty string')
  return {
    revokePhrases: phraseList(merged.revokePhrases, 'revokePhrases'),
    maxAgeSeconds,
    grantDir: expandHome(grantDir),
    // The first phrase as the owner wrote it, for the message that names it.
    revokeHint: merged.revokePhrases[0],
  }
}

const emit = (hookEventName, fields) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, ...fields } })}\n`)

/** A regular file (never a symlink) whose mtime is within (-60 s, maxAge). */
const fresh = (path, maxAgeSeconds) => {
  if (!path) return false
  try {
    const st = lstatSync(path)
    const age = Date.now() - st.mtimeMs
    return st.isFile() && age < maxAgeSeconds * 1000 && age > -60_000
  } catch {
    return false
  }
}

/** Creates a private directory; an existing one is tightened to 0700. */
const privateDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/** Writes a new file, never through a symlink someone planted at the path. */
const putFile = (path, content) => {
  rmSync(path, { force: true })
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
}

const readPending = (path) => {
  try {
    if (!lstatSync(path).isFile()) return ''
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

const main = () => {
  let ev
  try {
    ev = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    ev = null
  }
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    process.stderr.write('publish-grant hook: stdin is not a JSON object\n')
    process.exitCode = 1
    return
  }

  const cfg = loadConfig()
  // A malformed id is never sanitised into a valid one: it could match another session's grant.
  const sid = typeof ev.session_id === 'string' && SESSION_ID.test(ev.session_id) ? ev.session_id : ''
  const grant = sid ? join(cfg.grantDir, sid) : ''
  const pending = sid ? join(cfg.grantDir, 'pending', sid) : ''

  if (ev.hook_event_name === 'UserPromptSubmit') {
    const text = String(ev.prompt ?? '').toLowerCase()
    if (grant && cfg.revokePhrases.some((p) => text.includes(p))) {
      rmSync(grant, { force: true })
      rmSync(pending, { force: true })
      emit('UserPromptSubmit', {
        additionalContext: 'Publishing grant for this session REVOKED by the owner: the next publishDraft asks again.',
      })
    }
    return
  }

  if (!PUBLISH_TOOL.test(String(ev.tool_name ?? ''))) return
  const tuid = typeof ev.tool_use_id === 'string' && TOOL_USE_ID.test(ev.tool_use_id) ? ev.tool_use_id : ''

  if (ev.hook_event_name === 'PreToolUse') {
    if (fresh(grant, cfg.maxAgeSeconds)) {
      emit('PreToolUse', { permissionDecision: 'allow', permissionDecisionReason: 'the owner approved publishing for this session' })
      return
    }
    if (pending && tuid) {
      privateDir(join(cfg.grantDir, 'pending'))
      putFile(pending, tuid)
    }
    const hours = Math.round((cfg.maxAgeSeconds / 3600) * 10) / 10
    emit('PreToolUse', {
      permissionDecision: 'ask',
      permissionDecisionReason: `Approving this ${TOOL_NAME} call approves ${TOOL_NAME} for the rest of this session (${hours} h max). "${cfg.revokeHint}" revokes.`,
    })
    return
  }

  if (ev.hook_event_name === 'PostToolUse') {
    if (!pending || !tuid || NOBODY_ANSWERS.has(ev.permission_mode)) return
    if (readPending(pending) !== tuid) return
    rmSync(pending, { force: true })
    privateDir(cfg.grantDir)
    putFile(grant, '')
    emit('PostToolUse', {
      additionalContext: `The owner approved ${TOOL_NAME} in the permission dialog: publishing is approved for the rest of this session (${Math.round((cfg.maxAgeSeconds / 3600) * 10) / 10} h max). Showing the owner the content first still applies.`,
    })
  }
}

// Run only as a script: the installer imports TOOL_NAME from this file.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main()
