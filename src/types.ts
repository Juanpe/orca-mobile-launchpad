// Shapes shared by the worker, the panel and the platform adapters. Plain JSON only: they cross
// the panel <-> worker bridge and live in orca.storage.

/** Platforms Launchpad knows how to build. Android comes next (see README). */
export type Platform = 'ios'

export type DestinationKind = 'simulator' | 'device'

/** What a workspace remembers as "run here". */
export type Destination = {
  platform: Platform
  kind: DestinationKind
  udid: string
  name: string
}

export type Device = Destination & {
  /** `booted`/`shutdown` for simulators, `connected`/`unavailable` for physical devices. */
  state: 'booted' | 'shutdown' | 'connected' | 'unavailable'
  /** Physical devices only. */
  transport?: 'wifi' | 'cable'
  os: string
  /** Simulators only: what `simctl create` needs to make a sibling. */
  deviceTypeId?: string
  runtimeId?: string
}

/** An Xcode workspace or project found in the worktree. `path` is absolute. */
export type ProjectRef = {
  platform: Platform
  kind: 'workspace' | 'project'
  path: string
  /** Path relative to the worktree, for display. */
  label: string
}

export type WorkspaceConfig = {
  project?: string
  scheme?: string
  configuration: string
  destination?: Destination
}

export type RunPhase =
  | 'idle'
  | 'preparing'
  | 'building'
  | 'installing'
  | 'launching'
  | 'running'
  | 'exited'
  | 'stopped'
  | 'failed'
  | 'crashed'

export type RunState = {
  phase: RunPhase
  message?: string
  startedAt?: number
  /** When the current phase began: drives the panel's progress animation. */
  phaseStartedAt?: number
  finishedAt?: number
  /** The previous successful build of this worktree took this long; null while unknown. */
  estimatedBuildMs?: number
  /** Full build log on disk, and what the panel shows of it after a failure. */
  logPath?: string
  errors?: string[]
  logTail?: string
  /** Crash report on disk, and its summary, when the app crashed after launching. */
  crashPath?: string
  crashTitle?: string
  crashSummary?: string
  /** The Orca terminal that follows the run's output; closing it does not stop the run. */
  terminalId?: string
  /** The runner's process group, and the file its output goes to. */
  pid?: number
  outPath?: string
  destinationName?: string
  scheme?: string
}

export type WorkspaceInfo = {
  /** The id Orca's terminal and workspace calls take. */
  id: string
  name: string
  branch: string
  path: string
}

/** A run in a worktree other than the focused one. */
export type OtherRun = { workspace: WorkspaceInfo; run: RunState }

export type LaunchpadState = {
  workspace: WorkspaceInfo | null
  projects: ProjectRef[]
  config: WorkspaceConfig
  run: RunState
  /** Runs in other worktrees that are in progress, running, or ended badly a moment ago. */
  otherRuns: OtherRun[]
  /** Whether Orca lets the plugin switch worktrees and focus terminals (`workspace:write`). */
  canNavigate: boolean
}

export const ACTIVE_PHASES: readonly RunPhase[] = [
  'preparing',
  'building',
  'installing',
  'launching'
]

export function isActive(phase: RunPhase): boolean {
  return ACTIVE_PHASES.includes(phase)
}

/** The simulator name Launchpad gives a worktree, matching "<worktree> iPhone". */
export function worktreeSimulatorName(workspaceName: string): string {
  return `${workspaceName} iPhone`
}
