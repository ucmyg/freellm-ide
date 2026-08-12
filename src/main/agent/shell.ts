/**
 * How the agent invokes a shell.
 *
 * Windows needs a deliberate exit-status tail. `powershell -Command "<exe>"`
 * exits 1 for any failure rather than the program's real code, so without help
 * the agent cannot tell "3 tests failed" from "command not found". But
 * `exit $LASTEXITCODE` alone is worse than nothing: $LASTEXITCODE is only set
 * by native programs, so a *cmdlet* that fails leaves it $null and the tail
 * reports success for a command that failed.
 *
 * So capture both signals in the statement immediately after the command —
 * $? must be read first, since any statement in between would overwrite it —
 * and prefer the native code when there is one, falling back to $? otherwise.
 */
const WINDOWS_EXIT_TAIL = [
  '$__ok = $?; $__code = $LASTEXITCODE',
  'if ($null -ne $__code) { exit $__code }',
  'if (-not $__ok) { exit 1 }',
  'exit 0',
].join('\n')

export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NonInteractive', '-Command', `${command}\n${WINDOWS_EXIT_TAIL}`],
    }
  }
  // POSIX shells already exit with the last command's status.
  return { file: process.env.SHELL ?? '/bin/bash', args: ['-lc', command] }
}

export function shellName(): string {
  return process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash')
}
