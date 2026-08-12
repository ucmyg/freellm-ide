/**
 * How the agent invokes a shell.
 *
 * The `exit $LASTEXITCODE` tail matters: `powershell -Command "<exe>"` exits 1
 * for any failure rather than the program's real code, so without it the agent
 * cannot tell "3 tests failed" from "command not found". Appending it on its
 * own line propagates the child's actual status.
 *
 * $LASTEXITCODE is unset when the command was a pure cmdlet that never invoked
 * a native binary; PowerShell treats `exit $null` as 0, which is the right
 * answer for that case.
 */
export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NonInteractive', '-Command', `${command}\nexit $LASTEXITCODE`],
    }
  }
  return { file: process.env.SHELL ?? '/bin/bash', args: ['-lc', command] }
}

export function shellName(): string {
  return process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash')
}
