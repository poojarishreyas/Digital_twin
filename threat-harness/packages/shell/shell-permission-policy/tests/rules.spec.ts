/**
 * Parsing and matching permission rules, the read-only list, suggested rules, and verdicts.
 */

import { describe, expect, it } from 'vitest'
import {
  allowWords, evaluate, guardWords, isReadOnlyCommand, matchesExcluded, parseRule, patternMatcher, suggestRule,
} from '@elemental/shell-permission-policy'
import type { PermissionRules } from '@elemental/shell-permission-policy'

const rules = (allow: string[] = [], ask: string[] = [], deny: string[] = []): PermissionRules => ({
  allow: allow.map(parseRule), ask: ask.map(parseRule), deny: deny.map(parseRule),
})

describe('parseRule', () => {
  it('accepts each shell tool spelling', () => {
    expect(parseRule('bash(git status)').dialect).toBe('bash')
    expect(parseRule('Bash(git status)').dialect).toBe('bash')
    expect(parseRule('pwsh(git status)').dialect).toBe('pwsh')
    expect(parseRule('PowerShell(git status)').dialect).toBe('pwsh')
    expect(parseRule('  bash(git status)  ').source).toBe('  bash(git status)  ')
  })

  it.each(['git status', 'Read(a.ts)', 'bash()', 'bash(  )', 'bash git'])('rejects %j', (source) => {
    expect(() => parseRule(source)).toThrow(/invalid shell permission rule/)
  })
})

describe('patternMatcher', () => {
  it('matches an exact command, ignoring spacing', () => {
    const matches = patternMatcher('git  status', 'bash')
    expect(matches('git status')).toBe(true)
    expect(matches(' git   status ')).toBe(true)
    expect(matches('git status -s')).toBe(false)
  })

  it('matches a legacy prefix at a word boundary', () => {
    const matches = patternMatcher('npm run test:*', 'bash')
    expect(matches('npm run test')).toBe(true)
    expect(matches('npm run test -- --watch')).toBe(true)
    expect(matches('npm run testing')).toBe(false)
  })

  it('matches wildcards, with a trailing " *" also matching the bare prefix', () => {
    const trailing = patternMatcher('git log *', 'bash')
    expect(trailing('git log')).toBe(true)
    expect(trailing('git log --oneline')).toBe(true)
    expect(trailing('git logs')).toBe(false)
    const inner = patternMatcher('npx * --run', 'bash')
    expect(inner('npx vitest --run')).toBe(true)
    expect(inner('npx vitest')).toBe(false)
    const twoStars = patternMatcher('git * --oneline *', 'bash')
    expect(twoStars('git log --oneline -5')).toBe(true)
    expect(twoStars('git log --oneline')).toBe(false)
  })

  it('treats an escaped star and regex characters literally', () => {
    const star = patternMatcher('echo \\*', 'bash')
    expect(star('echo *')).toBe(true)
    expect(star('echo x')).toBe(false)
    const regexChars = patternMatcher('grep a.b(c) *', 'bash')
    expect(regexChars('grep a.b(c) x')).toBe(true)
    expect(regexChars('grep aXb(c) x')).toBe(false)
    const mixed = patternMatcher('ls \\* *', 'bash')
    expect(mixed('ls * -la')).toBe(true)
  })

  it('folds case for PowerShell only', () => {
    expect(patternMatcher('Get-ChildItem *', 'pwsh')('get-childitem -Recurse')).toBe(true)
    expect(patternMatcher('Get-Date', 'pwsh')('GET-DATE')).toBe(true)
    expect(patternMatcher('npm test:*', 'pwsh')('NPM TEST x')).toBe(true)
    expect(patternMatcher('Make *', 'bash')('make all')).toBe(false)
  })
})

describe('allowWords and guardWords', () => {
  it('drops only safe assignments for allow matching', () => {
    expect(allowWords(['NODE_ENV=test', 'CI=1', 'npm', 'test'])).toEqual(['npm', 'test'])
    expect(allowWords(['PATH=/evil', 'npm', 'test'])).toEqual(['PATH=/evil', 'npm', 'test'])
  })

  it('drops every assignment and wrapper for deny and ask matching', () => {
    expect(guardWords(['PATH=x', 'timeout', '-s', 'KILL', '10', 'rm', '-rf', 'dist'])).toEqual(['rm', '-rf', 'dist'])
    expect(guardWords(['timeout', '--signal=KILL', '10', 'rm', 'x'])).toEqual(['rm', 'x'])
    expect(guardWords(['sudo', '-u', 'root', 'env', 'A=1', 'rm', 'x'])).toEqual(['rm', 'x'])
    expect(guardWords(['nice', '-n', '5', 'make'])).toEqual(['make'])
    expect(guardWords(['env', '--', 'rm', 'x'])).toEqual(['rm', 'x'])
    expect(guardWords(['xargs', '-n', '1', 'rm'])).toEqual(['rm'])
    expect(guardWords(['nice', '-n'])).toEqual([])
    expect(guardWords(['timeout'])).toEqual([])
    expect(guardWords([])).toEqual([])
  })
})

describe('isReadOnlyCommand', () => {
  it.each([
    [['cat', 'a.ts'], 'bash'],
    [['pwd'], 'bash'],
    [['find', '.', '-name', '*.ts'], 'bash'],
    [['rg', '-n', 'x'], 'bash'],
    [['git', 'status'], 'bash'],
    [['git', '--no-pager', '-C', 'pkg', 'log', '-5'], 'bash'],
    [['git', 'branch', '-a'], 'bash'],
    [['git', 'stash', 'list'], 'bash'],
    [['git', 'reflog'], 'bash'],
    [['git', 'reflog', 'show'], 'bash'],
    [['git', 'config', '--get', 'user.name'], 'bash'],
    [['node', '--version'], 'bash'],
    [['printf', '%s\n', 'ok'], 'bash'],
    [['Get-ChildItem', '-Recurse'], 'pwsh'],
    [['GC', 'a.ts'], 'pwsh'],
  ] as const)('allows %j', (words, dialect) => {
    expect(isReadOnlyCommand(words, dialect)).toBe(true)
  })

  it.each([
    [[], 'bash'],
    [['pwd', '-P'], 'bash'],
    [['find', '.', '-delete'], 'bash'],
    [['rg', '--pre', 'sh', 'x'], 'bash'],
    [['git'], 'bash'],
    [['git', 'commit', '-m', 'x'], 'bash'],
    [['git', 'diff', '--output=x'], 'bash'],
    [['git', 'branch', 'new-feature'], 'bash'],
    [['git', 'stash'], 'bash'],
    [['git', 'reflog', 'expire'], 'bash'],
    [['git', 'config', 'user.name', 'x'], 'bash'],
    [['node', 'a.js'], 'bash'],
    [['npm', 'test'], 'bash'],
    [['rm', 'x'], 'bash'],
    [['printf', '-v', 'x', 'y'], 'bash'],
    [['Remove-Item', 'x'], 'pwsh'],
  ] as const)('does not allow %j', (words, dialect) => {
    expect(isReadOnlyCommand(words, dialect)).toBe(false)
  })
})

describe('suggestRule', () => {
  it.each([
    [['npm', 'run', 'test'], 'bash', 'bash(npm run *)'],
    [['NODE_ENV=test', 'pnpm', 'vitest', 'run'], 'bash', 'bash(pnpm vitest *)'],
    [['npm', 'test'], 'pwsh', 'pwsh(npm test *)'],
    [['make'], 'bash', 'bash(make)'],
    [['bash', '-c', 'echo hi'], 'bash', 'bash(bash -c echo hi)'],
    [['FOO=1', 'npm', 'test'], 'bash', 'bash(FOO=1 npm test)'],
    [['node', 'scripts/a.js'], 'bash', 'bash(node scripts/a.js)'],
    [['Get-ChildItem', '-Recurse'], 'pwsh', 'pwsh(Get-ChildItem -Recurse)'],
    [['ls', '*.ts'], 'bash', 'bash(ls \\*.ts)'],
  ] as const)('suggests for %j', (words, dialect, rule) => {
    expect(suggestRule(words, dialect)).toBe(rule)
  })
})

describe('evaluate', () => {
  it('allows read-only commands and commands every part of which a rule allows', () => {
    expect(evaluate('git status && cat a.ts', 'bash', rules())).toMatchObject({ behavior: 'allow' })
    expect(evaluate('cd pkg && pnpm vitest run', 'bash', rules(['bash(pnpm vitest *)']))).toMatchObject({ behavior: 'allow' })
    expect(evaluate('CI=1 npm test', 'bash', rules(['bash(npm test)']))).toMatchObject({ behavior: 'allow' })
  })

  it('asks with suggestions for the parts no rule allows', () => {
    expect(evaluate('git status && npm run build && npm run lint', 'bash', rules())).toEqual({
      behavior: 'ask', reason: 'no permission rule allows this command', byRule: false, suggestions: ['bash(npm run *)'],
    })
    expect(evaluate('PATH=/x npm test', 'bash', rules(['bash(npm test)']))).toMatchObject({ behavior: 'ask' })
  })

  it('lets deny beat ask and allow, and judges wrapped commands', () => {
    const set = rules(['bash(rm *)'], ['bash(rm *)'], ['bash(rm -rf *)'])
    expect(evaluate('echo a; timeout 5 rm -rf dist', 'bash', set)).toEqual({ behavior: 'deny', reason: 'denied by rule bash(rm -rf *)' })
    expect(evaluate('rm a.txt', 'bash', set)).toEqual({ behavior: 'ask', reason: 'rule bash(rm *) always asks', byRule: true, suggestions: [] })
  })

  it('judges an unsplittable line as a whole', () => {
    const line = 'echo $(date) > out.txt'
    expect(evaluate(line, 'bash', rules([], [], ['bash(echo *)']))).toEqual({ behavior: 'deny', reason: 'denied by rule bash(echo *)' })
    expect(evaluate(line, 'bash', rules([], ['bash(echo *)']))).toMatchObject({ behavior: 'ask', byRule: true })
    expect(evaluate(line, 'bash', rules([`bash(${line})`]))).toMatchObject({ behavior: 'allow' })
    expect(evaluate(line, 'bash', rules())).toMatchObject({ behavior: 'ask', byRule: false, suggestions: [] })
  })

  it('treats an empty line as allowed', () => {
    expect(evaluate('', 'bash', rules())).toMatchObject({ behavior: 'allow' })
  })
})

describe('matchesExcluded', () => {
  const excluded = [patternMatcher('pnpm vitest *', 'bash'), patternMatcher('npx tsc *', 'bash')]

  it('requires every command in the line to match', () => {
    expect(matchesExcluded('pnpm vitest run a.spec.ts', 'bash', excluded)).toBe(true)
    expect(matchesExcluded('NODE_ENV=test pnpm vitest run && npx tsc --noEmit', 'bash', excluded)).toBe(true)
    expect(matchesExcluded('pnpm vitest run && rm -rf x', 'bash', excluded)).toBe(false)
  })

  it('never matches without patterns, for an empty line, or for an unsplittable line', () => {
    expect(matchesExcluded('pnpm vitest run', 'bash', [])).toBe(false)
    expect(matchesExcluded('', 'bash', excluded)).toBe(false)
    expect(matchesExcluded('pnpm vitest run $(ls)', 'bash', excluded)).toBe(false)
  })
})
