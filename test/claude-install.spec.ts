import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `payload-mcp-publish claude-hook install|uninstall` on a temp HOME.
 * Mutations: bin removing the ask filter -> "removes only the publishDraft ask rules" red; skipping the deny rules ->
 * "adds deny rules" red; a hook command without `|| exit 2` on PreToolUse -> "fails closed" red; uninstall deleting
 * deny rules it did not add -> "uninstall keeps a deny rule that was already there" red.
 */
const PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}` // the node running the tests, not a version-manager shim
const BIN = fileURLToPath(new URL('../bin/payload-mcp-publish.mjs', import.meta.url))

let home: string
let settings: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'publish-install-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  settings = join(home, '.claude', 'settings.json')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, 'claude-hook', ...args], { env: { NODE_ENV: 'test', PATH, HOME: home }, encoding: 'utf8' })
  return { status: r.status, out: r.stdout, err: r.stderr }
}
const install = (...a: string[]) => cli('install', ...a)
const read = () => JSON.parse(readFileSync(settings, 'utf8'))
const hookPath = () => join(home, '.claude', 'hooks', 'payload-mcp-publish-grant.mjs')
const baks = () => readdirSync(join(home, '.claude')).filter((f) => f.startsWith('settings.json.bak-'))

const original = {
  model: 'opus',
  env: { A: '1' },
  permissions: {
    allow: ['Bash(ls:*)'],
    ask: ['mcp__site-a__publishDraft', 'mcp__site-b__publishDraft', 'mcp__site-a__updateParts', 'Bash(git push:*)'],
    deny: ['Read(./.env)'],
  },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
  },
}
const seed = (value: unknown = original, indent: string | number = 4) => writeFileSync(settings, `${JSON.stringify(value, null, indent)}\n`)

describe('claude-hook install', () => {
  it('registers both hooks, with fail-open prompt and fail-closed PreToolUse commands', () => {
    seed()
    const r = install()
    expect(r.status).toBe(0)
    const s = read()
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: `node "${hookPath()}" || exit 0` }] }])
    const pre = s.hooks.PreToolUse
    expect(pre[0]).toEqual(original.hooks.PreToolUse[0]) // the user's own hook is untouched and first
    expect(pre[1]).toEqual({ matcher: 'mcp__.*__publishDraft', hooks: [{ type: 'command', command: `node "${hookPath()}" || exit 2` }] })
    expect(existsSync(hookPath())).toBe(true)
  })

  it('removes only the publishDraft ask rules and prints them for restoring', () => {
    seed()
    const r = install()
    expect(read().permissions.ask).toEqual(['mcp__site-a__updateParts', 'Bash(git push:*)'])
    expect(r.out).toContain('mcp__site-a__publishDraft')
    expect(r.out).toContain('mcp__site-b__publishDraft')
  })

  it('adds deny rules for the grant directory', () => {
    seed()
    install()
    const deny = read().permissions.deny
    expect(deny).toEqual(['Read(./.env)', 'Write(~/.claude/state/publish-grants/**)', 'Edit(~/.claude/state/publish-grants/**)'])
  })

  it('keeps every unrelated key and the file indentation', () => {
    seed()
    install()
    const s = read()
    expect(s.model).toBe('opus')
    expect(s.env).toEqual({ A: '1' })
    expect(s.permissions.allow).toEqual(['Bash(ls:*)'])
    expect(s.hooks.Stop).toEqual(original.hooks.Stop)
    const raw = readFileSync(settings, 'utf8')
    expect(raw).toMatch(/^ {4}"model"/m)
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('writes a backup of the previous settings, and none when nothing changes', () => {
    seed()
    install()
    const b = baks()
    expect(b).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(home, '.claude', b[0]), 'utf8'))).toEqual(original)
    install()
    expect(baks()).toHaveLength(1)
  })

  it('is idempotent: a second run changes nothing, byte for byte', () => {
    seed()
    install()
    const first = readFileSync(settings, 'utf8')
    const r = install()
    expect(readFileSync(settings, 'utf8')).toBe(first)
    expect(r.out).toContain('already up to date')
    const s = read()
    expect(s.hooks.UserPromptSubmit).toHaveLength(1)
    expect(s.hooks.PreToolUse).toHaveLength(2)
    expect(s.permissions.deny).toHaveLength(3)
  })

  it('creates the settings file when there is none', () => {
    expect(install().status).toBe(0)
    expect(read().hooks.PreToolUse).toHaveLength(1)
    expect(baks()).toHaveLength(0)
  })

  it('--dry-run prints the diff and writes nothing', () => {
    seed()
    const before = readFileSync(settings, 'utf8')
    const r = install('--dry-run')
    expect(r.out).toContain('Dry run')
    expect(r.out).toMatch(/^\+ .*payload-mcp-publish-grant\.mjs/m)
    expect(r.out).toMatch(/^- .*mcp__site-a__publishDraft/m)
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(existsSync(hookPath())).toBe(false)
    expect(baks()).toHaveLength(0)
  })

  it('--grant/--revoke phrases land in the config, and a rerun without flags keeps them', () => {
    seed()
    install('--grant', 'разрешаю публикацию', '--grant', 'go live', '--revoke', 'запрещаю публикацию')
    const cfgPath = join(home, '.claude', 'hooks', 'payload-mcp-publish-grant.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.grantPhrases).toEqual(['разрешаю публикацию', 'go live'])
    expect(cfg.revokePhrases).toEqual(['запрещаю публикацию'])
    install()
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).grantPhrases).toEqual(['разрешаю публикацию', 'go live'])
  })

  it('refuses a blank phrase and an unparseable settings file, changing nothing', () => {
    seed()
    expect(install('--grant', '  ').status).toBe(1)
    writeFileSync(settings, '{ nope')
    const r = install()
    expect(r.status).toBe(1)
    expect(r.err).toContain('not valid JSON')
    expect(readFileSync(settings, 'utf8')).toBe('{ nope')
    expect(existsSync(hookPath())).toBe(false)
  })

  it('warns about a server-wide ask rule, which would still beat the grant', () => {
    seed({ permissions: { ask: ['mcp__site-a'] } })
    const r = install()
    expect(read().permissions.ask).toEqual(['mcp__site-a'])
    expect(r.out).toContain('Warning')
  })

  it('the installed hook works end to end through the registered command', () => {
    seed()
    install()
    const s = read()
    const run = (event: 'UserPromptSubmit' | 'PreToolUse', input: object, extraEnv: Record<string, string> = {}) => {
      const command = event === 'PreToolUse' ? s.hooks.PreToolUse[1].hooks[0].command : s.hooks.UserPromptSubmit[0].hooks[0].command
      return spawnSync('sh', ['-c', command], {
        input: JSON.stringify({ hook_event_name: event, session_id: 'E2E', ...input }),
        env: { NODE_ENV: 'test', PATH, HOME: home, ...extraEnv },
        encoding: 'utf8',
      })
    }
    const tool = { tool_name: 'mcp__site-a__publishDraft' }
    expect(JSON.parse(run('PreToolUse', tool).stdout).hookSpecificOutput.permissionDecision).toBe('ask')
    run('UserPromptSubmit', { prompt: 'publish-ok' })
    expect(JSON.parse(run('PreToolUse', tool).stdout).hookSpecificOutput.permissionDecision).toBe('allow')
    expect(existsSync(join(home, '.claude', 'state', 'publish-grants', 'E2E'))).toBe(true)
  })

  it('fails closed on PreToolUse and open on UserPromptSubmit when the hook crashes', () => {
    seed()
    install()
    writeFileSync(join(home, '.claude', 'hooks', 'payload-mcp-publish-grant.config.json'), '{broken')
    const s = read()
    const exec = (command: string, event: string) =>
      spawnSync('sh', ['-c', command], {
        input: JSON.stringify({ hook_event_name: event, session_id: 'X', tool_name: 'mcp__site-a__publishDraft', prompt: 'publish-ok' }),
        env: { NODE_ENV: 'test', PATH, HOME: home },
        encoding: 'utf8',
      })
    expect(exec(s.hooks.PreToolUse[1].hooks[0].command, 'PreToolUse').status).toBe(2)
    expect(exec(s.hooks.UserPromptSubmit[0].hooks[0].command, 'UserPromptSubmit').status).toBe(0)
  })
})

describe('claude-hook uninstall', () => {
  it('reverses what install added and prints the removed ask rules', () => {
    seed()
    install()
    const r = cli('uninstall')
    expect(r.status).toBe(0)
    const s = read()
    expect(s.hooks).toEqual(original.hooks)
    expect(s.permissions.deny).toEqual(['Read(./.env)'])
    expect(s.permissions.allow).toEqual(original.permissions.allow)
    expect(s.permissions.ask).toEqual(['mcp__site-a__updateParts', 'Bash(git push:*)']) // not restored, only printed
    expect(r.out).toContain('mcp__site-a__publishDraft')
    expect(existsSync(hookPath())).toBe(false)
  })

  it('restores a settings file that had none of these keys to an empty object', () => {
    install()
    cli('uninstall')
    expect(read()).toEqual({})
  })

  it('uninstall keeps a deny rule that was already there before install', () => {
    seed({ permissions: { deny: ['Write(~/.claude/state/publish-grants/**)'] } })
    install()
    install() // a rerun must not forget the first run's record
    cli('uninstall')
    expect(read().permissions.deny).toEqual(['Write(~/.claude/state/publish-grants/**)'])
  })

  it('uninstall --dry-run writes nothing', () => {
    seed()
    install()
    const before = readFileSync(settings, 'utf8')
    cli('uninstall', '--dry-run')
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(existsSync(hookPath())).toBe(true)
  })
})
