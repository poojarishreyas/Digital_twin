/**
 * Commands that only read, which run without a permission rule.
 *
 * A command counts only in a form that cannot write files, run other programs, or change
 * repository state: `find` without actions, `rg` without a preprocessor, `git` read-only
 * subcommands without `--output`, and branch/tag/remote listings without a name argument.
 *
 * @module @elemental/shell-permission-policy/allowlist
 */

import type { ShellDialect } from '@elemental/shell'

/** bash commands that only read, with any arguments. */
const BASH_ANY_ARGS: ReadonlySet<string> = new Set([
  'cat', 'head', 'tail', 'wc', 'stat', 'nl', 'diff', 'cmp', 'comm', 'cut', 'paste', 'tr', 'tac', 'rev', 'fold',
  'column', 'basename', 'dirname', 'realpath', 'readlink', 'echo', 'ls', 'cd', 'which', 'type', 'du', 'df',
  'uname', 'id', 'groups', 'nproc', 'true', 'false', 'sleep', 'seq', 'file', 'tree', 'grep', 'egrep', 'fgrep',
  'md5sum', 'sha1sum', 'sha256sum', 'jq', 'printenv',
])

/** bash commands that only read when run without arguments. */
const BASH_NO_ARGS: ReadonlySet<string> = new Set(['pwd', 'whoami', 'date', 'hostname'])

/** PowerShell commands (lowercase) that only read, with any arguments. */
const PWSH_ANY_ARGS: ReadonlySet<string> = new Set([
  'get-content', 'gc', 'cat', 'type', 'get-childitem', 'gci', 'dir', 'ls', 'select-string', 'sls',
  'get-location', 'gl', 'pwd', 'test-path', 'get-item', 'gi', 'get-itemproperty', 'resolve-path', 'rvpa',
  'get-command', 'gcm', 'measure-object', 'measure', 'select-object', 'select', 'sort-object', 'sort',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'get-date', 'get-process', 'gps', 'write-output',
  'echo', 'get-filehash', 'set-location', 'cd', 'sl', 'split-path', 'join-path', 'get-member', 'gm',
])

/** Command names for both shells that are judged by their arguments below. */
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])

/** `git` subcommands that only read. */
const GIT_READ: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-remote', 'rev-parse', 'describe', 'shortlog',
  'cat-file', 'for-each-ref', 'grep', 'rev-list', 'merge-base', 'name-rev', 'show-ref', 'whatchanged', 'version',
])

/** Options that make `git branch`, `git tag`, or `git remote` list instead of change. */
const GIT_LIST_FLAGS: ReadonlySet<string> = new Set([
  '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current', '--merged', '--no-merged', '--contains',
])

/**
 * Whether a simple command only reads.
 * @param words - the command's words, after safe environment assignments are dropped.
 * @param dialect - the shell it runs in.
 * @returns `true` for a command on the read-only list in a read-only form.
 */
export function isReadOnlyCommand(words: readonly string[], dialect: ShellDialect): boolean {
  const [first, ...args] = words
  if (first === undefined) return false
  const name = dialect === 'pwsh' ? first.toLowerCase() : first
  if (name === 'git') return isReadOnlyGit(args)
  if (name === 'find') return !args.some(arg => FIND_ACTIONS.has(arg))
  // `--pre` runs a program on every file.
  if (name === 'rg') return !args.some(arg => arg.startsWith('--pre'))
  // `printf -v` assigns a shell variable; without options it only prints.
  if (name === 'printf' && dialect === 'bash') return !args.some(arg => arg.startsWith('-'))
  if (name === 'node' || name === 'python' || name === 'python3' || name === 'npm' || name === 'pnpm') {
    return args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')
  }
  if (dialect === 'pwsh') return PWSH_ANY_ARGS.has(name)
  if (BASH_NO_ARGS.has(name)) return args.length === 0
  return BASH_ANY_ARGS.has(name)
}

function isReadOnlyGit(args: readonly string[]): boolean {
  let rest = args
  // `git --no-pager <sub>` and `git -C <dir> <sub>` run the subcommand as usual.
  for (;;) {
    if (rest[0] === '--no-pager') rest = rest.slice(1)
    else if (rest[0] === '-C' && rest.length > 1) rest = rest.slice(2)
    else break
  }
  const [sub, ...options] = rest
  if (sub === undefined || options.some(option => option.startsWith('--output'))) return false
  if (GIT_READ.has(sub)) return true
  if (sub === 'branch' || sub === 'tag' || sub === 'remote') return options.every(option => GIT_LIST_FLAGS.has(option))
  if (sub === 'stash' || sub === 'worktree') return options.length === 1 && options[0] === 'list'
  if (sub === 'reflog') return options.length === 0 || options[0] === 'show'
  if (sub === 'config') return options.some(option => option.startsWith('--get') || option === '--list' || option === '-l')
  return false
}
