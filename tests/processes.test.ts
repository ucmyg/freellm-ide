import os from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import {
  listBackground,
  readBackground,
  startBackground,
  stopAllBackground,
  stopBackground,
} from '../src/main/agent/processes'

afterEach(() => stopAllBackground())

/** Poll until `check` passes, so tests do not race process startup. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition never became true')
}

describe('background processes', () => {
  test('captures output and reports exit', async () => {
    const info = startBackground('node -e "console.log(\'alpha\'); console.log(\'beta\')"', os.tmpdir())
    expect(info.running).toBe(true)

    await until(() => !readBackground(info.id).running)

    const out = readBackground(info.id)
    expect(out.lines).toContain('alpha')
    expect(out.lines).toContain('beta')
    expect(out.exitCode).toBe(0)
  })

  test('a cursor returns only new lines', async () => {
    const info = startBackground('node -e "console.log(1); console.log(2); console.log(3)"', os.tmpdir())
    await until(() => !readBackground(info.id).running)

    const first = readBackground(info.id, 0, 2)
    expect(first.lines).toHaveLength(2)

    const second = readBackground(info.id, first.nextCursor)
    expect(second.lines).not.toEqual(first.lines)
    expect(second.nextCursor).toBeGreaterThanOrEqual(first.nextCursor)
  })

  test('stops a process that would otherwise run forever', async () => {
    const info = startBackground('node -e "setInterval(() => {}, 1000)"', os.tmpdir())
    await until(() => listBackground().some((p) => p.id === info.id))
    expect(readBackground(info.id).running).toBe(true)

    const stopped = stopBackground(info.id)
    expect(stopped.running).toBe(false)
  })

  test('reports a nonzero exit rather than swallowing it', async () => {
    const info = startBackground('node -e "process.exit(3)"', os.tmpdir())
    await until(() => !readBackground(info.id).running)
    expect(readBackground(info.id).exitCode).toBe(3)
  })

  test('an unknown id is an error, not a silent empty read', () => {
    expect(() => readBackground('nope')).toThrow(/No background process/)
    expect(() => stopBackground('nope')).toThrow(/No background process/)
  })
})
