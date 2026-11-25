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

export type RunState = {
  phase: RunPhase
  message?: string
  startedAt?: number
  finishedAt?: number
  terminalId?: string
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

export type LaunchpadState = {
  workspace: WorkspaceInfo | null
  projects: ProjectRef[]
  config: WorkspaceConfig
  run: RunState
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
