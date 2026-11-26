import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Claude Code session-grant hook, driven as a real process with the event on stdin.
 * The grant is the owner's Yes in the permission dialog (PreToolUse "ask" -> PostToolUse of the same tool_use_id);
 * a prompt never grants, because UserPromptSubmit also fires for scheduled tasks, /loop and subagent reports.
 * Mutations: claude/publish-grant-hook.mjs PostToolUse granting without comparing the pending id -> "PostToolUse of a call
 * never asked", "a different tool_use_id" and "another session" go red; PostToolUse without the NOBODY_ANSWERS check ->
 * "bypassPermissions never grants" goes red; `fresh` without lstat/isFile -> "a symlinked grant" goes red; PreToolUse
 * returning allow without a fresh grant -> every "asks" case goes red; UserPromptSubmit granting on a phrase -> "a typed
 * grant-like phrase does not grant" goes red.
 */
const PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}` // the node running the tests, not a version-manager shim
const HOOK = fileURLToPath(new URL('../claude/publish-grant-hook.mjs', import.meta.url))

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-grant-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (input: unknown, env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { NODE_ENV: 'test', PATH, PUBLISH_GRANT_DIR: dir, ...env },
    encoding: 'utf8',
  })
  const out = r.stdout.trim()
  return { status: r.status, raw: out, hso: out ? JSON.parse(out).hookSpecificOutput : undefined, stderr: r.stderr }
}
const decision = (input: unknown, env?: Record<string, string>) => {
  const { hso } = run(input, env)
  return hso ? (hso.permissionDecision ?? 'ctx') : 'none'
}

const pre = (session_id: unknown, tool_use_id: string, server = 'site-a') => ({
  hook_event_name: 'PreToolUse',
  session_id,
  tool_name: `mcp__${server}__publishDraft`,
  tool_use_id,
  tool_input: {},
})
const post = (session_id: unknown, tool_use_id: string, permission_mode = 'default', server = 'site-a') => ({
  hook_event_name: 'PostToolUse',
  session_id,
  tool_name: `mcp__${server}__publishDraft`,
  tool_use_id,
  permission_mode,
})
const prompt = (session_id: string, text: string) => ({ hook_event_name: 'UserPromptSubmit', session_id, prompt: text })
const grantFile = (sid: string) => join(dir, sid)

describe('publish grant hook: the owner’s Yes in the dialog grants once per session', () => {
  // Order matters: the cases follow one session's life.
  it('no grant: publish asks, records the call as pending, and the reason says what a Yes covers and how to revoke', () => {
    const r = run(pre('S1', 'tu1'))
    expect(r.status).toBe(0)
    expect(r.hso.hookEventName).toBe('PreToolUse')
    expect(r.hso.permissionDecision).toBe('ask')
    expect(r.hso.permissionDecisionReason).toContain('approves publishDraft for the rest of this session')
    expect(r.hso.permissionDecisionReason).toContain('publish-stop')
    expect(readFileSync(join(dir, 'pending', 'S1'), 'utf8')).toBe('tu1')
  })

  it('a typed grant-like phrase does not grant', () => {
    for (const text of ['allow publishing', 'publish-ok', 'разрешаю публикацию publish-ok'])
      expect(decision(prompt('S1', text))).toBe('none')
    expect(existsSync(grantFile('S1'))).toBe(false)
    expect(decision(pre('S1', 'tu2'))).toBe('ask')
  })

  it('PostToolUse of a call that was never asked does not grant', () => {
    expect(decision(post('S1', 'tuX'))).toBe('none') // pending holds tu2
    expect(decision(pre('S1', 'tu3'))).toBe('ask')
    expect(decision(post('S1', 'tu2'))).toBe('none') // a stale id: pending now holds tu3
    expect(existsSync(grantFile('S1'))).toBe(false)
  })

  it('the owner said Yes to the pending call: the session is granted, with an empty private file', () => {
    const r = run(post('S1', 'tu3'))
    expect(r.hso.hookEventName).toBe('PostToolUse')
    expect(r.hso.additionalContext).toContain('approved publishDraft in the permission dialog')
    expect(readFileSync(grantFile('S1'), 'utf8')).toBe('')
    expect(statSync(grantFile('S1')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir, 'pending', 'S1'))).toBe(false)
  })

  it('granted: later calls are allowed, on any site of the same session', () => {
    expect(run(pre('S1', 'tu4')).hso.permissionDecision).toBe('allow')
    expect(decision(pre('S1', 'tu5', 'site-b'))).toBe('allow')
  })

  it('another session still asks, and its Yes is needed', () => {
    expect(decision(pre('S2', 'tu6'))).toBe('ask')
    expect(decision(post('S1', 'tu6'))).toBe('none') // S1's id does not complete S2's pending call
    expect(decision(pre('S2', 'tu6b'))).toBe('ask')
  })

  it('a run in bypassPermissions or dontAsk never grants, because nobody answered', () => {
    expect(decision(pre('S2', 'tu7'))).toBe('ask')
    expect(decision(post('S2', 'tu7', 'bypassPermissions'))).toBe('none')
    expect(decision(post('S2', 'tu7', 'dontAsk'))).toBe('none')
    expect(existsSync(grantFile('S2'))).toBe(false)
    expect(decision(pre('S2', 'tu7b'))).toBe('ask')
  })

  it('a run in auto mode grants: the hook’s ask still reaches the human there', () => {
    expect(decision(pre('S2', 'tu7c'))).toBe('ask')
    expect(decision(post('S2', 'tu7c', 'auto'))).toBe('ctx')
    rmSync(grantFile('S2'))
  })

  it('leaves other tools untouched', () => {
    expect(decision({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'mcp__site-a__updateParts', tool_use_id: 'tu8' })).toBe(
      'none',
    )
    expect(decision({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'mcp__site-a__publishDraftX', tool_use_id: 'tu8' })).toBe(
      'none',
    )
    expect(decision({ hook_event_name: 'PostToolUse', session_id: 'S9', tool_name: 'Bash', tool_use_id: 'tu8' })).toBe('none')
  })

  it('a malformed, non-string or empty session id asks and is never sanitised into a valid one', () => {
    for (const sid of ['../S1', 'S1/', 'S1\n', 'S 1', '', 'x'.repeat(129), 5, null]) expect(decision(pre(sid, 'tu9'))).toBe('ask')
    expect(decision({ hook_event_name: 'PreToolUse', tool_name: 'mcp__site-a__publishDraft', tool_use_id: 'tu9' })).toBe('ask')
    expect(decision(post('../S1', 'tu9'))).toBe('none')
    expect(decision(prompt('../S1', 'publish-stop'))).toBe('none')
    expect(existsSync(join(dirname(dir), 'S1'))).toBe(false) // nothing was written outside the grant directory
  })

  it('a tool_use_id that is not [A-Za-z0-9_-]{1,200} is never recorded or granted', () => {
    expect(decision(pre('S5', 'tu 1'))).toBe('ask')
    expect(existsSync(join(dir, 'pending', 'S5'))).toBe(false)
    writeFileSync(join(dir, 'pending', 'S5'), 'a b')
    expect(decision(post('S5', 'a b'))).toBe('none')
    expect(decision(post('S5', ''))).toBe('none')
    expect(decision(post('S5', 'x'.repeat(201)))).toBe('none')
  })

  it('a grant older than 24 h asks, and a fresh Yes re-grants', () => {
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(grantFile('S1'), old, old)
    expect(decision(pre('S1', 'tu10'))).toBe('ask')
    expect(decision(post('S1', 'tu10'))).toBe('ctx')
    expect(decision(pre('S1', 'tu10b'))).toBe('allow')
  })

  it('a grant dated in the future is not fresh', () => {
    const future = new Date(Date.now() + 3_600_000)
    utimesSync(grantFile('S1'), future, future)
    expect(decision(pre('S1', 'tu10c'))).toBe('ask')
    expect(decision(post('S1', 'tu10c'))).toBe('ctx')
  })

  it('the owner revokes by prompt; revoked: publish asks, and a stale pending call cannot re-grant', () => {
    expect(decision(pre('S1', 'tu11p'))).toBe('allow')
    writeFileSync(join(dir, 'pending', 'S1'), 'tu11')
    expect(run(prompt('S1', 'Please STOP publishing now')).hso.additionalContext).toContain('REVOKED')
    expect(existsSync(grantFile('S1'))).toBe(false)
    expect(existsSync(join(dir, 'pending', 'S1'))).toBe(false)
    expect(decision(post('S1', 'tu11'))).toBe('none')
    expect(decision(pre('S1', 'tu12'))).toBe('ask')
  })

  it('a symlinked grant is not a grant', () => {
    symlinkSync('/etc/hosts', grantFile('S3'))
    expect(decision(pre('S3', 'tu13'))).toBe('ask')
  })

  it('a symlink planted at the pending path is replaced, not written through', () => {
    const victim = join(dir, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(dir, 'pending', 'S6'))
    expect(decision(pre('S6', 'tu14'))).toBe('ask')
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(readFileSync(join(dir, 'pending', 'S6'), 'utf8')).toBe('tu14')
  })

  it('an existing grant directory is tightened to 0700', () => {
    chmodSync(dir, 0o755)
    expect(decision(pre('S7', 'tu15'))).toBe('ask')
    expect(decision(post('S7', 'tu15'))).toBe('ctx')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'pending')).mode & 0o777).toBe(0o700)
  })

  it('unreadable stdin exits non-zero with no decision (the registered command blocks PreToolUse on it)', () => {
    for (const input of ['not json', '', 'null', '5', '[]']) {
      const r = run(input)
      expect(r.status).toBe(1)
      expect(r.raw).toBe('')
    }
  })

  it('a custom max age expires a grant sooner', () => {
    run(pre('S8', 'tu16'))
    run(post('S8', 'tu16'))
    const past = new Date(Date.now() - 120_000)
    utimesSync(grantFile('S8'), past, past)
    expect(decision(pre('S8', 'tu17'), { PUBLISH_GRANT_MAX_AGE: '3600' })).toBe('allow')
    expect(decision(pre('S8', 'tu18'), { PUBLISH_GRANT_MAX_AGE: '60' })).toBe('ask')
  })

  describe('configuration file', () => {
    const cfg = (c: unknown) => {
      const path = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(path, typeof c === 'string' ? c : JSON.stringify(c))
      return { PUBLISH_GRANT_CONFIG: path }
    }

    it('a Cyrillic revoke phrase works case-insensitively and is named in the ask reason', () => {
      const env = cfg({ revokePhrases: ['запрещаю публикацию'] })
      run(pre('S9', 'tuc1'), env)
      run(post('S9', 'tuc1'), env)
      expect(decision(pre('S9', 'tuc2'), env)).toBe('allow')
      expect(run(prompt('S9', 'Да, ЗАПРЕЩАЮ Публикацию'), env).hso.additionalContext).toContain('REVOKED')
      const r = run(pre('S9', 'tuc3'), env)
      expect(r.hso.permissionDecision).toBe('ask')
      expect(r.hso.permissionDecisionReason).toContain('запрещаю публикацию')
    })

    it('the default revoke phrases stop working once the config replaces them', () => {
      const env = cfg({ revokePhrases: ['pull the plug'] })
      run(pre('S10', 'tud1'), env)
      run(post('S10', 'tud1'), env)
      expect(decision(prompt('S10', 'publish-stop'), env)).toBe('none')
      expect(decision(pre('S10', 'tud2'), env)).toBe('allow')
    })

    it('an invalid config crashes instead of falling back to defaults', () => {
      for (const bad of [
        '{not json',
        { revokePhrases: [''] },
        { revokePhrases: [] },
        { revokePhrases: 'publish-stop' },
        { maxAgeSeconds: -1 },
      ]) {
        const r = run(pre('S11', 'tue1'), cfg(bad))
        expect(r.status).not.toBe(0)
        expect(r.raw).toBe('')
      }
    })
  })
})
