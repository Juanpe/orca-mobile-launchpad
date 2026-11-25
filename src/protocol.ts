// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Device, LaunchpadState, WorkspaceConfig } from './types'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Everything the panel draws for the focused workspace. */
    'state.get': { output: LaunchpadState }
    /** Schemes of the selected project (cached unless `refresh`). */
    'schemes.list': {
      input: { refresh?: boolean }
      output: { schemes: string[]; appSchemes: string[]; error?: string }
    }
    /** Simulators and physical devices for the selected project's platform. */
    'devices.list': { output: { devices: Device[]; error?: string } }
    /** Merges into the focused workspace's config and answers the new state. */
    'config.update': { input: Partial<WorkspaceConfig>; output: LaunchpadState }
    /** Build & run the focused workspace with its config. */
    run: { output: LaunchpadState }
    /** Stop the focused workspace's run. */
    stop: { output: LaunchpadState }
    /** Opens the last run's build log or crash report in Console. */
    'log.open': { input: { kind: 'build' | 'crash' }; output: { opened: boolean } }
    /** Create (or reuse) the "<worktree> iPhone" simulator from `baseUdid`'s model and OS, and
     *  select it. */
    'simulator.createForWorktree': {
      input: { baseUdid: string }
      output: { state: LaunchpadState; device: Device }
    }
  }
  interface PluginPanelEvents {
    /** Posted after the focused workspace, its config or its run changes. */
    'state.changed': LaunchpadState
  }
}
