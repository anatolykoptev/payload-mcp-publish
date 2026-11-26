import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Claude Code session-grant hook, driven as a real process with the event on stdin.
 * Mutation: claude/publish-grant-hook.mjs `fresh` always true -> "no grant: publish asks" and the three "asks" cases go red;
 * `allow` returned without the freshness/session check -> "other session still asks", "grant older than 24 h asks" go red.
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

const pub = (session_id: string, server = 'site-a') => ({
  hook_event_name: 'PreToolUse',
  session_id,
  tool_name: `mcp__${server}__publishDraft`,
  tool_input: {},
})
const prompt = (session_id: string, text: string) => ({ hook_event_name: 'UserPromptSubmit', session_id, prompt: text })

describe('publish grant hook', () => {
  // Order matters: the cases mirror one session's life, as the original shell test did.
  it('no grant: publish asks, and the reason names the grant phrase', () => {
    const r = run(pub('S1'))
    expect(r.status).toBe(0)
    expect(r.hso.permissionDecision).toBe('ask')
    expect(r.hso.permissionDecisionReason).toContain('publish-ok')
    expect(r.hso.hookEventName).toBe('PreToolUse')
  })

  it('leaves other tools untouched', () => {
    expect(decision({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'mcp__site-a__updateParts' })).toBe('none')
    expect(decision({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'mcp__site-a__publishDraftX' })).toBe('none')
  })

  it('a typed grant phrase answers with context, case-insensitively and as a substring', () => {
    const r = run(prompt('S1', 'Yes, ALLOW Publishing for this session'))
    expect(r.hso.additionalContext).toContain('granted publishing')
    expect(r.hso.permissionDecision).toBeUndefined()
  })

  it('granted: publish is allowed, for any site of the same session', () => {
    expect(decision(pub('S1'))).toBe('allow')
    expect(decision(pub('S1', 'site-b'))).toBe('allow')
  })

  it('another session still asks', () => {
    expect(decision(pub('S2'))).toBe('ask')
  })

  it('an ordinary prompt changes nothing', () => {
    expect(decision(prompt('S1', 'publish it'))).toBe('none')
    expect(decision(pub('S1'))).toBe('allow')
  })

  it('a malformed session id never matches, and is not sanitised into a valid one', () => {
    for (const sid of ['../S1', 'S1/', 'S1\n', 'S 1', '', 'x'.repeat(129)]) expect(decision(pub(sid))).toBe('ask')
    expect(decision({ hook_event_name: 'PreToolUse', tool_name: 'mcp__site-a__publishDraft' })).toBe('ask')
    expect(decision(prompt('../S1', 'publish-ok'))).toBe('none')
  })

  it('a grant older than 24 h asks', () => {
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(dir, 'S1'), old, old)
    expect(decision(pub('S1'))).toBe('ask')
  })

  it('the owner grants again, then revokes', () => {
    expect(run(prompt('S1', 'publish-ok')).hso.additionalContext).toContain('granted')
    expect(decision(pub('S1'))).toBe('allow')
    expect(run(prompt('S1', 'stop publishing now')).hso.additionalContext).toContain('REVOKED')
    expect(decision(pub('S1'))).toBe('ask')
  })

  it('a prompt with both phrases revokes', () => {
    run(prompt('S3', 'publish-ok'))
    expect(run(prompt('S3', 'publish-ok ... publish-stop')).hso.additionalContext).toContain('REVOKED')
    expect(decision(pub('S3'))).toBe('ask')
  })

  it('garbage stdin is a silent no-op with exit 0', () => {
    for (const input of ['not json', '', 'null', '5']) {
      const r = run(input)
      expect(r.status).toBe(0)
      expect(r.raw).toBe('')
    }
  })

  it('a custom max age expires a grant sooner', () => {
    run(prompt('S4', 'publish-ok'))
    const past = new Date(Date.now() - 120_000)
    utimesSync(join(dir, 'S4'), past, past)
    expect(decision(pub('S4'), { PUBLISH_GRANT_MAX_AGE: '3600' })).toBe('allow')
    expect(decision(pub('S4'), { PUBLISH_GRANT_MAX_AGE: '60' })).toBe('ask')
  })

  describe('configuration file', () => {
    const cfg = (c: unknown) => {
      const path = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(path, typeof c === 'string' ? c : JSON.stringify(c))
      return { PUBLISH_GRANT_CONFIG: path }
    }

    it('a Cyrillic grant phrase and its revoke phrase work, case-insensitively', () => {
      const env = cfg({ grantPhrases: ['разрешаю публикацию'], revokePhrases: ['запрещаю публикацию'] })
      expect(decision(pub('S5'), env)).toBe('ask')
      expect(run(prompt('S5', 'Да, РАЗРЕШАЮ Публикацию на эту сессию'), env).hso.additionalContext).toContain('granted')
      expect(decision(pub('S5'), env)).toBe('allow')
      expect(run(prompt('S5', 'запрещаю публикацию'), env).hso.additionalContext).toContain('REVOKED')
      expect(decision(pub('S5'), env)).toBe('ask')
      expect(run(pub('S5'), env).hso.permissionDecisionReason).toContain('разрешаю публикацию')
    })

    it('the default phrases no longer grant once the config replaces them', () => {
      const env = cfg({ grantPhrases: ['go ahead and publish'] })
      expect(decision(prompt('S6', 'publish-ok'), env)).toBe('none')
      expect(decision(pub('S6'), env)).toBe('ask')
    })

    it('an invalid config crashes instead of falling back to defaults', () => {
      for (const bad of [
        '{not json',
        { grantPhrases: [''] },
        { grantPhrases: [] },
        { revokePhrases: 'publish-stop' },
        { maxAgeSeconds: -1 },
      ]) {
        const r = run(pub('S7'), cfg(bad))
        expect(r.status).not.toBe(0)
        expect(r.raw).toBe('')
      }
    })
  })
})
