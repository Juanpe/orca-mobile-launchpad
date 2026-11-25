import type { RunPhase, RunState } from './types'

/** The progress bar's band for each active phase, in percent. */
const BANDS: Partial<Record<RunPhase, [number, number]>> = {
  preparing: [2, 12],
  building: [12, 84],
  installing: [84, 93],
  launching: [93, 99]
}

/** Where the progress bar is now. The build band follows the worktree's last build time when
 *  known, and eases towards its end otherwise, so the bar keeps moving without overshooting. */
export function progressOf(run: RunState, now: number): number {
  const band = BANDS[run.phase]
  if (!band) return run.phase === 'running' ? 100 : 0
  const elapsed = Math.max(0, now - (run.phaseStartedAt ?? run.startedAt ?? now))
  let fraction: number
  if (run.phase === 'building') {
    const expected = run.estimatedBuildMs ?? 90_000
    fraction =
      elapsed < expected
        ? 0.9 * (elapsed / expected)
        : 0.9 + 0.09 * (1 - Math.exp(-(elapsed - expected) / expected))
  } else {
    fraction = 1 - Math.exp(-elapsed / 4000)
  }
  return Math.round(band[0] + (band[1] - band[0]) * fraction)
}
