import { execFile } from 'node:child_process'

export type ExecResult = { stdout: string; stderr: string }

/** Runs a program without a shell. Rejects with stderr in the message on a non-zero exit. */
export function exec(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args as string[],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ')
          reject(new Error(detail ? `${file} ${args[0] ?? ''}: ${detail}` : error.message))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

/** Quotes one argument for a POSIX shell (bash or zsh). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
