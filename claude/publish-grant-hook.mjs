#!/usr/bin/env node
/**
 * Claude Code hook: the owner approves `publishDraft` once per session instead of on every call.
 *
 * UserPromptSubmit: a prompt the human typed that contains a grant phrase writes a grant for this
 *   session; a revoke phrase deletes it. Only a human prompt reaches this event, so the agent cannot
 *   grant itself.
 * PreToolUse on `mcp__<server>__publishDraft`: a fresh grant for this session answers "allow", anything
 *   else answers "ask" (the owner is prompted, as an `ask` rule would have done).
 *
 * Reads the hook event as JSON on stdin. Configuration, in order of precedence: the environment
 * (PUBLISH_GRANT_DIR, PUBLISH_GRANT_MAX_AGE in seconds, PUBLISH_GRANT_CONFIG for the config path), then the
 * sibling JSON file (`<this file without .mjs>.config.json`: grantPhrases, revokePhrases, maxAgeSeconds,
 * grantDir), then the defaults below. A config file that exists but is invalid throws: the registered
 * command turns a crash into a blocked PreToolUse call and an ignored UserPromptSubmit crash.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULTS = {
  grantPhrases: ['publish-ok', 'allow publishing'],
  revokePhrases: ['publish-stop', 'stop publishing'],
  maxAgeSeconds: 24 * 3600,
  grantDir: '~/.claude/state/publish-grants',
}
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const PUBLISH_TOOL = /^mcp__[A-Za-z0-9_-]+__publishDraft$/

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
    grantPhrases: phraseList(merged.grantPhrases, 'grantPhrases'),
    revokePhrases: phraseList(merged.revokePhrases, 'revokePhrases'),
    maxAgeSeconds,
    grantDir: expandHome(grantDir),
    // The first phrase as the owner wrote it, for the message that names it.
    grantHint: merged.grantPhrases[0],
  }
}

const emit = (hookEventName, fields) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, ...fields } })}\n`)

const main = () => {
  let ev
  try {
    ev = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return // unreadable input: change nothing, Claude Code's own rules apply
  }
  if (ev === null || typeof ev !== 'object') return

  const cfg = loadConfig()
  // A malformed id is never sanitised into a valid one: it could match another session's grant.
  const sid = typeof ev.session_id === 'string' && SESSION_ID.test(ev.session_id) ? ev.session_id : ''
  const path = sid ? join(cfg.grantDir, sid) : ''

  if (ev.hook_event_name === 'UserPromptSubmit' && path) {
    const text = String(ev.prompt ?? '').toLowerCase()
    if (cfg.revokePhrases.some((p) => text.includes(p))) {
      rmSync(path, { force: true })
      emit('UserPromptSubmit', {
        additionalContext: 'Publishing grant for this session REVOKED by the owner: publishDraft asks for approval again.',
      })
    } else if (cfg.grantPhrases.some((p) => text.includes(p))) {
      mkdirSync(cfg.grantDir, { recursive: true, mode: 0o700 })
      writeFileSync(path, String(Math.floor(Date.now() / 1000)), { mode: 0o600 })
      const hours = Math.round((cfg.maxAgeSeconds / 3600) * 10) / 10
      emit('UserPromptSubmit', {
        additionalContext: `The owner granted publishing for this session: publishDraft runs without a prompt until the session ends (${hours} h at most). The dry run, the digest and showing the owner the content first still apply.`,
      })
    }
    return
  }

  if (ev.hook_event_name === 'PreToolUse' && PUBLISH_TOOL.test(String(ev.tool_name ?? ''))) {
    let fresh = false
    if (path) {
      try {
        const st = statSync(path)
        const age = Date.now() - st.mtimeMs
        fresh = st.isFile() && age < cfg.maxAgeSeconds * 1000 && age > -60_000
      } catch {
        fresh = false
      }
    }
    if (fresh) emit('PreToolUse', { permissionDecision: 'allow', permissionDecisionReason: 'owner granted publishing for this session' })
    else
      emit('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: `Publishing needs your OK. To allow it for the whole session, write "${cfg.grantHint}".`,
      })
  }
}

main()
