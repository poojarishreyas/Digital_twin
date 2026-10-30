/**
 * The words of one simple command that each kind of rule judges.
 * @module @elemental/shell-permission-policy/words
 */

/** Environment variables a command prefix may set without changing what the command does. */
const SAFE_ENV: ReadonlySet<string> = new Set([
  'NODE_ENV', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'COLORTERM', 'TERM', 'TZ', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'RUST_BACKTRACE', 'RUST_LOG', 'GOOS', 'GOARCH', 'CGO_ENABLED',
  'GO111MODULE', 'GOEXPERIMENT', 'DEBIAN_FRONTEND', 'GIT_TERMINAL_PROMPT', 'COLUMNS', 'LINES',
])

/**
 * Commands that run the command after them, each with its options that take a separate value;
 * a deny or ask rule judges the wrapped command.
 */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['stdbuf', new Set(['-i', '--input', '-o', '--output', '-e', '--error'])],
  ['command', new Set()],
  ['builtin', new Set()],
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user'])],
  ['doas', new Set(['-u', '-C'])],
  ['xargs', new Set(['-I', '-n', '--max-args', '-P', '--max-procs', '-L', '--max-lines', '-s', '--max-chars', '-d', '--delimiter', '-E', '-a', '--arg-file'])],
])

const ASSIGNMENT = /^([A-Za-z_]\w*)=/u

/**
 * The text allow rules and the read-only list judge: leading assignments of safe variables are
 * dropped; any other assignment stays, so an allow rule cannot cover a command whose environment
 * changes what it runs.
 * @param words - one simple command's words.
 * @returns the remaining words.
 */
export function allowWords(words: readonly string[]): string[] {
  let start = 0
  while (start < words.length && SAFE_ENV.has(ASSIGNMENT.exec(words[start] as string)?.[1] ?? '')) start += 1
  return words.slice(start)
}

/**
 * The text deny and ask rules judge: every leading assignment and wrapper command (with its
 * options, their values, and, for `timeout`, its duration) is dropped, so a wrapper cannot slip
 * past them.
 * @param words - one simple command's words.
 * @returns the remaining words.
 */
export function guardWords(words: readonly string[]): string[] {
  let rest = [...words]
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0] as string)) rest = rest.slice(1)
    const head = rest[0]
    const valued = head === undefined ? undefined : WRAPPERS.get(head)
    if (valued === undefined) return rest
    rest = rest.slice(1)
    while (rest.length > 0 && (rest[0] as string).startsWith('-')) {
      const option = rest[0] as string
      rest = rest.slice(1)
      // `--` ends the options; `-s KILL` carries its value in the next word, `-sKILL` and `--signal=KILL` in this one.
      if (option === '--') break
      if (valued.has(option) && rest.length > 0) rest = rest.slice(1)
    }
    if (head === 'timeout' && rest.length > 0) rest = rest.slice(1)
  }
}
