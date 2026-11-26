import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `payload-mcp-publish claude-hook install|uninstall` on a temp HOME.
 * Mutations: bin removing the ask filter -> "removes only the publishDraft ask rules" red; skipping the deny rules ->
 * "adds deny rules" red; a PreToolUse command without `|| exit 2` -> "fails closed" red; uninstall deleting deny rules it
 * did not add -> "uninstall keeps a deny rule that was already there" red; uninstall not restoring the ask rules ->
 * "reverses what install added" and "restores the ask rules" red; PostToolUse not registered -> "registers" and
 * "end to end" red.
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

const cli = (args: string[], cwd?: string) => {
  const r = spawnSync(process.execPath, [BIN, 'claude-hook', ...args], {
    env: { NODE_ENV: 'test', PATH, HOME: home },
    encoding: 'utf8',
    cwd,
  })
  return { status: r.status, out: r.stdout, err: r.stderr }
}
const install = (...a: string[]) => cli(['install', ...a])
const uninstall = (...a: string[]) => cli(['uninstall', ...a])
const read = () => JSON.parse(readFileSync(settings, 'utf8'))
const hooksDir = () => join(home, '.claude', 'hooks')
const hookPath = () => join(hooksDir(), 'payload-mcp-publish-grant.mjs')
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
const DENY = ['Edit(~/.claude/state/publish-grants/**)', 'Edit(~/.claude/hooks/payload-mcp-publish-grant*)']

describe('claude-hook install', () => {
  it('registers the three hooks; PreToolUse fails closed, the others fail open', () => {
    seed()
    const r = install()
    expect(r.status).toBe(0)
    const s = read()
    const cmd = (code: number) => `node "${hookPath()}" || exit ${code}`
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: cmd(0) }] }])
    expect(s.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]) // the user's own hook is untouched and first
    expect(s.hooks.PreToolUse[1]).toEqual({
      matcher: 'mcp__.*__publishDraft',
      hooks: [{ type: 'command', command: cmd(2), onFailure: 'block' }],
    })
    expect(s.hooks.PostToolUse).toEqual([{ matcher: 'mcp__.*__publishDraft', hooks: [{ type: 'command', command: cmd(0) }] }])
    expect(existsSync(hookPath())).toBe(true)
  })

  it('removes only the publishDraft ask rules and prints them for restoring', () => {
    seed()
    const r = install()
    expect(read().permissions.ask).toEqual(['mcp__site-a__updateParts', 'Bash(git push:*)'])
    expect(r.out).toContain('mcp__site-a__publishDraft')
    expect(r.out).toContain('mcp__site-b__publishDraft')
  })

  it('adds Edit deny rules for the grant directory and the installed hook; no inert Write rules', () => {
    seed()
    install()
    expect(read().permissions.deny).toEqual(['Read(./.env)', ...DENY])
    expect(JSON.stringify(read())).not.toContain('Write(')
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

  it('writes a backup of the previous settings, leaves no temp file, and writes no backup when nothing changes', () => {
    seed()
    install()
    const b = baks()
    expect(b).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(home, '.claude', b[0]), 'utf8'))).toEqual(original)
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('.tmp-'))).toEqual([])
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
    expect(s.hooks.PostToolUse).toHaveLength(1)
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

  it('--revoke phrases land in the config, a rerun without flags keeps them, and there is no grant phrase', () => {
    seed()
    install('--revoke', 'запрещаю публикацию', '--revoke', 'pull the plug')
    const cfgPath = join(hooksDir(), 'payload-mcp-publish-grant.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.revokePhrases).toEqual(['запрещаю публикацию', 'pull the plug'])
    expect(cfg).not.toHaveProperty('grantPhrases')
    install()
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).revokePhrases).toEqual(['запрещаю публикацию', 'pull the plug'])
    const r = install('--grant', 'publish-ok')
    expect(r.status).toBe(1)
    expect(r.err).toContain('--grant is gone')
  })

  it('refuses a blank phrase and an unparseable settings file, changing nothing', () => {
    seed()
    expect(install('--revoke', '  ').status).toBe(1)
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

  it('warns when project settings in the working directory hold publishDraft ask rules', () => {
    seed()
    const project = join(home, 'project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { ask: ['mcp__site-c__publishDraft'] } }))
    const r = cli(['install'], project)
    expect(r.out).toContain('settings.local.json')
    expect(r.out).toContain('mcp__site-c__publishDraft')
    expect(cli(['install'], home).out).not.toContain('settings.local.json')
  })

  it('the installed hook completes the dialog flow through the registered commands (ask, Yes, allow)', () => {
    seed()
    install()
    const s = read()
    const exec = (command: string, input: object) =>
      spawnSync('sh', ['-c', command], {
        input: JSON.stringify({
          session_id: 'E2E',
          tool_name: 'mcp__site-a__publishDraft',
          tool_use_id: 'tu1',
          permission_mode: 'default',
          ...input,
        }),
        env: { NODE_ENV: 'test', PATH, HOME: home },
        encoding: 'utf8',
      })
    const preCmd = s.hooks.PreToolUse[1].hooks[0].command
    const postCmd = s.hooks.PostToolUse[0].hooks[0].command
    const decision = (id: string) =>
      JSON.parse(exec(preCmd, { hook_event_name: 'PreToolUse', tool_use_id: id }).stdout).hookSpecificOutput.permissionDecision
    expect(decision('tu1')).toBe('ask')
    expect(exec(postCmd, { hook_event_name: 'PostToolUse', tool_use_id: 'tu1' }).stdout).toContain('approved publishDraft')
    expect(existsSync(join(home, '.claude', 'state', 'publish-grants', 'E2E'))).toBe(true)
    expect(decision('tu2')).toBe('allow')
  })

  it('fails closed on PreToolUse and open elsewhere when the hook crashes or gets unreadable input', () => {
    seed()
    install()
    const s = read()
    const exec = (command: string, input: string) =>
      spawnSync('sh', ['-c', command], { input, env: { NODE_ENV: 'test', PATH, HOME: home }, encoding: 'utf8' })
    const pre = s.hooks.PreToolUse[1].hooks[0].command
    const others = [s.hooks.UserPromptSubmit[0].hooks[0].command, s.hooks.PostToolUse[0].hooks[0].command]
    // unreadable stdin: the hook exits 1
    expect(exec(pre, 'not json').status).toBe(2)
    for (const c of others) expect(exec(c, 'not json').status).toBe(0)
    // a broken config: the hook throws
    writeFileSync(join(hooksDir(), 'payload-mcp-publish-grant.config.json'), '{broken')
    const event = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'X',
      tool_name: 'mcp__site-a__publishDraft',
      tool_use_id: 'tu1',
    })
    expect(exec(pre, event).status).toBe(2)
    for (const c of others) expect(exec(c, event).status).toBe(0)
  })
})

describe('claude-hook uninstall', () => {
  it('reverses what install added and restores the ask rules install removed', () => {
    seed()
    install()
    const r = uninstall()
    expect(r.status).toBe(0)
    const s = read()
    expect(s.hooks).toEqual(original.hooks)
    expect(s.permissions.deny).toEqual(['Read(./.env)'])
    expect(s.permissions.allow).toEqual(original.permissions.allow)
    expect([...s.permissions.ask].sort()).toEqual([...original.permissions.ask].sort())
    expect(r.out).toContain('restored permissions.ask')
    expect(existsSync(hookPath())).toBe(false)
  })

  it('restores the ask rules when install left no ask list at all, without duplicates on a second uninstall', () => {
    seed({ permissions: { ask: ['mcp__site-a__publishDraft'] } })
    install()
    expect(read().permissions.ask).toBeUndefined()
    uninstall()
    expect(read()).toEqual({ permissions: { ask: ['mcp__site-a__publishDraft'] } })
    uninstall()
    expect(read()).toEqual({ permissions: { ask: ['mcp__site-a__publishDraft'] } })
  })

  it('restores a settings file that had none of these keys to an empty object', () => {
    install()
    uninstall()
    expect(read()).toEqual({})
  })

  it('uninstall keeps a deny rule that was already there before install', () => {
    seed({ permissions: { deny: [DENY[0]] } })
    install()
    install() // a rerun must not forget the first run's record
    uninstall()
    expect(read().permissions.deny).toEqual([DENY[0]])
  })

  it('uninstall --dry-run writes nothing', () => {
    seed()
    install()
    const before = readFileSync(settings, 'utf8')
    uninstall('--dry-run')
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(existsSync(hookPath())).toBe(true)
  })
})
