// What every platform's run shares: the work folder, starting a runner script apart from any
// terminal, following its output, and stopping it.
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '../exec'

/** Where Launchpad keeps its runner script and status files. */
export async function workDir(): Promise<string> {
  // Tests point it elsewhere (MOBILE_LAUNCHPAD_WORKDIR) so they never touch real runs' files.
  const dir = process.env.MOBILE_LAUNCHPAD_WORKDIR || join(tmpdir(), 'orca-launchpad')
  await mkdir(dir, { recursive: true })
  return dir
}

/** Writes a runner script into the work folder; answers its path. */
export async function writeScript(name: string, body: string): Promise<string> {
  const script = join(await workDir(), name)
  await writeFile(script, body, 'utf8')
  await chmod(script, 0o755)
  return script
}

/**
 * Starts a runner script as its own process group, apart from any terminal: opening, closing or
 * interrupting a terminal never stops a build. Its output goes to `outFile`, which an Orca
 * terminal follows (`followCommand`). Answers the group's pid for `stopProcessGroup`.
 */
export function spawnRunner(script: string, args: string[], cwd: string, outFile: string): number {
  const out = openSync(outFile, 'w')
  try {
    // Tests swap the runner for a stand-in (MOBILE_LAUNCHPAD_RUNNER) instead of running xcodebuild.
    const runner = process.env.MOBILE_LAUNCHPAD_RUNNER || script
    // A login shell gives the runner the person's PATH (orca, xcbeautify) as a terminal would.
    const child = spawn('/bin/zsh', ['-lc', 'exec /bin/bash "$@"', 'mobile-launchpad', runner, ...args], {
      cwd,
      detached: true,
      stdio: ['ignore', out, out],
      // Orca's own CLI in PATH lets the runner open the emulator pane.
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    child.unref()
    if (!child.pid) throw new Error('Could not start the build')
    return child.pid
  } finally {
    closeSync(out)
  }
}

/** Follows a run's output from its first line, and returns once the runner exits, so the terminal
 *  goes back to its prompt (idle for Orca) instead of looking busy forever. */
const FOLLOW_SCRIPT = `#!/bin/bash
# Mobile Launchpad: shows a run's output until the run ends. Written by the plugin.
tail -n +1 -f "$1" &
T=$!
while kill -0 "$2" 2> /dev/null; do sleep 1; done
sleep 1
kill "$T" 2> /dev/null
wait "$T" 2> /dev/null
exit 0
`

/** The command an Orca terminal runs to show a run's output live while the run lasts. */
export async function followCommand(outFile: string, pid: number): Promise<string> {
  const script = join(await workDir(), 'follow.sh')
  await writeFile(script, FOLLOW_SCRIPT, 'utf8')
  await chmod(script, 0o755)
  return `${shellQuote(script)} ${shellQuote(outFile)} ${pid}`
}

/** Stops a run started by `startRun`: the runner and everything it started (xcodebuild,
 *  simctl, devicectl). The runner's trap marks the run `stopped`. */
export function stopProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
