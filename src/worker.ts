// Mobile Launchpad's worker: follows the focused workspace, keeps each workspace's run config, drives
// the status bar item, and runs builds in an Orca terminal of that workspace.
import { progressOf } from './progress'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { exec } from './exec'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol'
import {
  createSimulator,
  findProjects,
  listAppSchemes,
  listDevices,
  listSchemes,
  followCommand,
  isAlive,
  startRun,
  stopProcessGroup,
  workDir
} from './platforms/ios'
import {
  extractBuildErrors,
  logTail,
  preferredDestination,
  preferredScheme,
  summarizeCrash
} from './platforms/ios-parse'
import {
  isActive,
  worktreeSimulatorName,
  type Device,
  type LaunchpadState,
  type OtherRun,
  type ProjectRef,
  type RunPhase,
  type RunState,
  type WorkspaceConfig,
  type WorkspaceInfo
} from './types'

const STATUS_ITEM = 'run'
const POLL_MS = 1000
const SPIN_MS = 250
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DEFAULT_CONFIG: WorkspaceConfig = { configuration: 'Debug' }

type Context = { workspaceId?: string; branch: string; displayName: string } | null

/** Timers the worker owns; `deactivate` clears them so a disabled plugin leaves nothing running. */
const timers = new Set<ReturnType<typeof setInterval>>()

function every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
  const timer = setInterval(fn, ms)
  ;(timer as { unref?: () => void }).unref?.() // Orca keeps the worker alive, not its timers
  timers.add(timer)
  return timer
}

function cancel(timer: ReturnType<typeof setInterval> | undefined): void {
  if (!timer) return
  clearInterval(timer)
  timers.delete(timer)
}

export function deactivate(): void {
  for (const timer of timers) clearInterval(timer)
  timers.clear()
}

export default function activate(orca: OrcaWorkerApi): void {
  let focused: WorkspaceInfo | null = null
  let focusedProjects: ProjectRef[] = []
  const runs = new Map<string, RunState>() // by workspace path
  const runWorkspaces = new Map<string, WorkspaceInfo>() // the worktree each run belongs to
  const pollers = new Map<string, ReturnType<typeof setInterval>>()
  const schemeCache = new Map<string, { schemes: string[]; appSchemes: string[] }>()
  let spinTimer: ReturnType<typeof setInterval> | undefined
  let spinFrame = 0
  let spinBackoff = 0

  const configKey = (path: string) => `config:${path}`
  const fileFor = async (path: string, kind: 'status' | 'build' | 'out') =>
    join(await workDir(), `${kind}-${createHash('sha1').update(path).digest('hex').slice(0, 12)}.${kind === 'status' ? 'txt' : 'log'}`)
  const buildTimeKey = (path: string) => `buildMs:${path}`

  async function readConfig(path: string): Promise<WorkspaceConfig> {
    const stored = await orca.storage.get(configKey(path))
    return { ...DEFAULT_CONFIG, ...((stored as WorkspaceConfig | null) ?? {}) }
  }

  async function writeConfig(path: string, patch: Partial<WorkspaceConfig>): Promise<WorkspaceConfig> {
    const next = { ...(await readConfig(path)), ...patch }
    // Storage takes JSON only: drop the keys a patch cleared with `undefined`.
    const json = JSON.parse(JSON.stringify(next)) as WorkspaceConfig
    await orca.storage.set(configKey(path), json)
    return json
  }

  /** Maps Orca's focused-workspace context to the workspace's path. */
  async function resolveWorkspace(context: Context): Promise<WorkspaceInfo | null> {
    if (!context?.workspaceId) return null
    const { workspaces } = await orca.host.call('workspace.list')
    const row =
      workspaces.find((w) => w.id === context.workspaceId) ??
      workspaces.find((w) => context.workspaceId!.endsWith(w.id) || w.id.endsWith(context.workspaceId!))
    if (!row) {
      orca.log(`workspace ${context.workspaceId} not found in workspace.list`)
      return null
    }
    return { id: context.workspaceId, name: context.displayName || row.name, branch: context.branch, path: row.path }
  }

  const canNavigate = () => orca.grantedCapabilities.includes('workspace:write')
  const RECENT_MS = 15 * 60_000

  /** Runs outside the focused worktree worth showing: in progress, running, or a failure or crash
   *  from the last few minutes. */
  function otherRuns(): OtherRun[] {
    const now = Date.now()
    const out: OtherRun[] = []
    for (const [path, run] of runs) {
      const workspace = runWorkspaces.get(path)
      if (!workspace || path === focused?.path) continue
      const recentBadEnd = (run.phase === 'failed' || run.phase === 'crashed') && now - (run.finishedAt ?? 0) < RECENT_MS
      if (isActive(run.phase) || run.phase === 'running' || recentBadEnd) out.push({ workspace, run })
    }
    return out.sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0))
  }

  async function state(): Promise<LaunchpadState> {
    if (!focused) {
      return toJson({
        workspace: null,
        projects: [],
        config: DEFAULT_CONFIG,
        run: { phase: 'idle' as const },
        otherRuns: otherRuns(),
        canNavigate: canNavigate()
      })
    }
    let config = await readConfig(focused.path)
    if (!config.project || !focusedProjects.some((p) => p.path === config.project)) {
      if (focusedProjects[0]) config = await writeConfig(focused.path, { project: focusedProjects[0].path, scheme: undefined })
    }
    return toJson({
      workspace: focused,
      projects: focusedProjects,
      config,
      run: runs.get(focused.path) ?? { phase: 'idle' },
      otherRuns: otherRuns(),
      canNavigate: canNavigate()
    })
  }

  let lastState: LaunchpadState | null = null

  async function publish(): Promise<LaunchpadState> {
    const s = await state()
    lastState = s
    orca.panels.post('state.changed', s)
    await updateStatusBar(s).catch((e) => orca.log(`statusBar.update: ${(e as Error).message}`))
    animateStatusBar(s)
    return s
  }

  /** Spins the status bar item while the focused workspace builds. */
  function animateStatusBar(s: LaunchpadState): void {
    const active = [...runs.values()].some((r) => isActive(r.phase))
    if (active && !spinTimer) {
      spinTimer = every(SPIN_MS, () => {
        if (spinBackoff > 0) return void spinBackoff--
        spinFrame = (spinFrame + 1) % SPINNER.length
        if (lastState) {
          updateStatusBar(lastState).catch((e: Error & { code?: string }) => {
            spinBackoff = e.code === 'rate_limited' ? 8 : 0
          })
        }
      })
    } else if (!active && spinTimer) {
      cancel(spinTimer)
      spinTimer = undefined
    }
  }

  async function updateStatusBar(s: LaunchpadState): Promise<void> {
    const elsewhere = s.otherRuns.filter((o) => isActive(o.run.phase)).length
    const elsewhereText = elsewhere ? `${SPINNER[spinFrame]} ${elsewhere} building elsewhere` : ''
    if (!s.workspace || s.projects.length === 0) {
      // Nothing to run here, but keep showing builds that go on in other worktrees.
      await orca.host.call(
        'statusBar.update',
        elsewhere
          ? { id: STATUS_ITEM, visible: true, text: elsewhereText, icon: 'hammer', tone: 'accent', tooltip: s.otherRuns.map((o) => `${o.run.scheme} · ${o.workspace.name}`).join('\n') }
          : { id: STATUS_ITEM, visible: false }
      )
      return
    }
    const target = s.config.destination?.name ?? 'choose a destination'
    const scheme = s.config.scheme ?? s.projects[0]?.label.split('/').pop()?.replace(/\.\w+$/, '')
    const run = s.run
    const labels: Partial<Record<RunPhase, string>> = {
      preparing: 'Preparing',
      building: 'Building',
      installing: 'Installing',
      launching: 'Launching'
    }
    let item: { text: string; icon: 'rocket' | 'hammer' | 'play' | 'error' | 'stop'; tone: 'neutral' | 'accent' | 'success' | 'danger'; tooltip: string }
    if (isActive(run.phase)) {
      item = { text: `${SPINNER[spinFrame]} ${labels[run.phase]} ${progressOf(run, Date.now())}% · ${target}`, icon: 'hammer', tone: 'accent', tooltip: `${run.scheme} → ${target}. Click to restart.` }
    } else if (run.phase === 'running') {
      item = { text: `${run.scheme} · ${target}`, icon: 'play', tone: 'success', tooltip: `Running on ${target}. Click to rebuild and relaunch.` }
    } else if (run.phase === 'failed') {
      item = { text: `Failed · ${target}`, icon: 'error', tone: 'danger', tooltip: `${run.message ?? 'Build failed'}. Click to retry.` }
    } else if (run.phase === 'crashed') {
      item = { text: `Crashed · ${target}`, icon: 'error', tone: 'danger', tooltip: `${run.scheme} crashed: ${run.crashTitle ?? 'see the crash report'}. Click to relaunch.` }
    } else {
      item = { text: `${scheme ?? 'Run'} · ${target}`, icon: 'rocket', tone: 'neutral', tooltip: `Build & Run ${s.workspace.name} on ${target}` }
    }
    if (elsewhereText) {
      item.text = `${item.text}  ·  ${elsewhereText}`
      item.tooltip = `${item.tooltip}\nAlso: ${s.otherRuns.map((o) => `${o.run.scheme} · ${o.workspace.name}`).join(', ')}`
    }
    await orca.host.call('statusBar.update', { id: STATUS_ITEM, visible: true, ...item })
  }

  // Focus changes are serialized: the first workspace.changed and a panel's state.get arrive
  // together, and a second focus must not publish before the first has found the projects.
  let focusChain: Promise<void> = Promise.resolve()
  function focus(context: Context): Promise<void> {
    focusChain = focusChain.then(() => applyFocus(context)).catch((e) => orca.log(`focus: ${(e as Error).message}`))
    return focusChain
  }

  async function applyFocus(context: Context): Promise<void> {
    const next = await resolveWorkspace(context).catch((e) => {
      orca.log(`resolveWorkspace: ${(e as Error).message}`)
      return null
    })
    if (next?.path !== focused?.path) {
      focusedProjects = next ? await findProjects(next.path) : []
    }
    focused = next // name and branch may change while the path stays
    await publish()
  }

  async function ensureFocused(): Promise<WorkspaceInfo> {
    if (!focused) await focus(await orca.host.call('workspace.readContext'))
    if (!focused) throw Object.assign(new Error('No active workspace'), { code: 'action_failed' })
    return focused
  }

  async function schemesFor(project: string, refresh = false): Promise<{ schemes: string[]; appSchemes: string[] }> {
    if (!refresh && schemeCache.has(project)) return schemeCache.get(project)!
    const [schemes, appSchemes] = await Promise.all([listSchemes(project), listAppSchemes(project)])
    const entry = { schemes, appSchemes }
    schemeCache.set(project, entry)
    return entry
  }

  function setRun(path: string, run: RunState): void {
    runs.set(path, toJson(run))
    if (!isActive(run.phase) && run.phase !== 'running') stopPolling(path)
  }

  function stopPolling(path: string): void {
    cancel(pollers.get(path))
    pollers.delete(path)
  }

  /** What the panel shows after a failed build: the errors and the end of the log. */
  async function failureDetails(logPath: string): Promise<Partial<RunState>> {
    const log = await readFile(logPath, 'utf8').catch(() => '')
    if (!log) return {}
    return { errors: extractBuildErrors(log), logTail: logTail(log) }
  }

  async function crashDetails(crashPath: string): Promise<Partial<RunState>> {
    try {
      const { title, summary } = summarizeCrash(await readFile(crashPath, 'utf8'))
      return { crashPath, crashTitle: title, crashSummary: summary.slice(0, 12_000) }
    } catch (e) {
      orca.log(`crash report ${crashPath}: ${(e as Error).message}`)
      return { crashPath }
    }
  }

  function startPolling(workspace: WorkspaceInfo, statusFile: string): void {
    stopPolling(workspace.path)
    let ticks = 0
    let last = ''
    const timer = every(POLL_MS, async () => {
      ticks++
      const run = runs.get(workspace.path)
      if (!run) return stopPolling(workspace.path)
      const raw = (await readFile(statusFile, 'utf8').catch(() => '')).trim()
      // A runner killed outside Mobile Launchpad (say SIGKILL) never writes its last phase.
      if (ticks % 3 === 0 && run.pid && !isAlive(run.pid) && raw === last) {
        if (isActive(run.phase) || run.phase === 'running') {
          setRun(workspace.path, { ...run, phase: 'stopped', finishedAt: Date.now() })
          await publish()
        }
        return
      }
      if (!raw || raw === last) return
      last = raw
      const [word, ...rest] = raw.split(':')
      const phase = word as RunPhase
      const detail = rest.join(':') || undefined
      const now = Date.now()
      const finished = phase === 'failed' || phase === 'exited' || phase === 'stopped' || phase === 'crashed'
      if (run.phase === 'building' && phase !== 'building' && phase !== 'failed' && run.phaseStartedAt) {
        await orca.storage.set(buildTimeKey(workspace.path), now - run.phaseStartedAt)
      }
      let extra: Partial<RunState> = {}
      if (phase === 'failed' && run.logPath) extra = await failureDetails(run.logPath)
      if (phase === 'crashed' && detail) extra = await crashDetails(detail)
      setRun(workspace.path, {
        ...run,
        phase,
        message: phase === 'crashed' ? undefined : detail,
        phaseStartedAt: now,
        finishedAt: finished ? now : undefined,
        ...extra
      })
      if (phase === 'failed') {
        void notify(`${run.scheme}: ${detail ?? 'failed'}`, workspace.name)
      } else if (phase === 'crashed') {
        void notify(`${run.scheme} crashed: ${extra.crashTitle ?? 'see the crash report'}`, workspace.name)
      } else if (phase === 'running') {
        void notify(`${run.scheme} is running on ${run.destinationName}`, workspace.name)
      }
      await publish()
    })
    pollers.set(workspace.path, timer)
  }

  async function notify(body: string, title: string): Promise<void> {
    await orca.host.call('notifications.show', { title: `Mobile Launchpad · ${title}`, body }).catch(() => undefined)
  }

  /** Ends a worktree's run (its whole process group) and closes the terminal that follows it. */
  async function endRun(path: string): Promise<void> {
    const run = runs.get(path)
    if (run?.pid) stopProcessGroup(run.pid)
    if (run?.terminalId) {
      await orca.host.call('terminal.close', { terminalId: run.terminalId }).catch(() => undefined)
    }
  }

  /** A terminal in the run's worktree that follows its output; made again if it was closed. */
  async function showRunTerminal(path: string): Promise<boolean> {
    const run = runs.get(path)
    const workspace = runWorkspaces.get(path)
    if (!run?.outPath || !workspace) return false
    const open = run.terminalId
      ? await orca.host
          .call('terminal.list', { workspaceId: workspace.id })
          .then((r) => r.terminals.some((t) => t.id === run.terminalId))
          .catch(() => false)
      : false
    let terminalId = run.terminalId
    if (!open) {
      terminalId = (
        await orca.host.call('terminal.create', {
          workspaceId: workspace.id,
          title: `▶ ${run.scheme}`,
          command: followCommand(run.outPath)
        })
      ).terminalId
      setRun(path, { ...run, terminalId })
    }
    return (await orca.host.call('terminal.focus', { terminalId: terminalId! })).focused
  }

  async function runFocused(): Promise<LaunchpadState> {
    const workspace = await ensureFocused()
    let s = await state()
    if (!s.config.project) throw Object.assign(new Error('No Xcode project found in this worktree'), { code: 'action_failed' })
    let config = s.config
    if (!config.scheme) {
      const { schemes, appSchemes } = await schemesFor(config.project!)
      const scheme = preferredScheme(schemes, config.project!, appSchemes)
      if (!scheme) throw Object.assign(new Error('The project has no shared schemes'), { code: 'action_failed' })
      config = await writeConfig(workspace.path, { scheme })
    }
    if (!config.destination) {
      const { devices } = await listDevices()
      const device = preferredDestination(devices, worktreeSimulatorName(workspace.name))
      if (!device) throw Object.assign(new Error('No simulators or devices available'), { code: 'action_failed' })
      config = await writeConfig(workspace.path, { destination: pickDestination(device) })
    }
    await endRun(workspace.path)
    const statusFile = await fileFor(workspace.path, 'status')
    const logFile = await fileFor(workspace.path, 'build')
    const outFile = await fileFor(workspace.path, 'out')
    await writeFile(statusFile, 'preparing\n', 'utf8')
    const estimate = await orca.storage.get(buildTimeKey(workspace.path))
    const pid = await startRun(
      {
        projectPath: config.project!,
        scheme: config.scheme!,
        configuration: config.configuration,
        destination: config.destination!,
        statusFile,
        logFile,
        openSimulatorApp: true
      },
      outFile
    )
    // The terminal only follows the output: closing it does not touch the build.
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId: workspace.id,
      title: `▶ ${config.scheme}`,
      command: followCommand(outFile)
    })
    const now = Date.now()
    runWorkspaces.set(workspace.path, workspace)
    setRun(workspace.path, {
      phase: 'preparing',
      startedAt: now,
      phaseStartedAt: now,
      estimatedBuildMs: typeof estimate === 'number' ? estimate : undefined,
      logPath: logFile,
      outPath: outFile,
      pid,
      terminalId,
      scheme: config.scheme,
      destinationName: config.destination!.name
    })
    startPolling(workspace, statusFile)
    s = await publish()
    return s
  }

  async function stopRun(path?: string): Promise<LaunchpadState> {
    const target = path ?? (await ensureFocused()).path
    const run = runs.get(target)
    if (run?.pid) stopProcessGroup(run.pid)
    // Keep the terminal: it shows how the run ended.
    if (run && (isActive(run.phase) || run.phase === 'running')) {
      setRun(target, { ...run, phase: 'stopped', finishedAt: Date.now() })
    }
    return publish()
  }

  // Status bar press, palette and shortcut.
  orca.commands.register('launchpad.run', async () => {
    try {
      const s = await runFocused()
      return `Build & Run: ${s.config.scheme} → ${s.config.destination?.name}`
    } catch (e) {
      const message = (e as Error).message
      await notify(message, focused?.name ?? 'Mobile Launchpad')
      return message
    }
  })
  orca.commands.register('launchpad.stop', async () => {
    await stopRun()
    return 'Stopped'
  })

  orca.events.on('workspace.changed', ({ context }) => focus(context))

  orca.panels.handle('state.get', async () => {
    if (!focused) await focus(await orca.host.call('workspace.readContext'))
    return state()
  })

  orca.panels.handle('schemes.list', async ({ refresh }) => {
    const s = await state()
    if (!s.config.project) return { schemes: [], appSchemes: [] }
    try {
      return await schemesFor(s.config.project, refresh)
    } catch (e) {
      return { schemes: [], appSchemes: [], error: (e as Error).message }
    }
  })

  orca.panels.handle('devices.list', () => listDevices())

  orca.panels.handle('config.update', async (patch) => {
    const workspace = await ensureFocused()
    // `null` clears a field; a new project invalidates the scheme picked for the old one.
    const cleared = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, v === null ? undefined : v])
    ) as Partial<WorkspaceConfig>
    const clean = cleared.project !== undefined && !('scheme' in patch) ? { ...cleared, scheme: undefined } : cleared
    await writeConfig(workspace.path, clean)
    return publish()
  })

  orca.panels.handle('log.open', async ({ kind }) => {
    const workspace = await ensureFocused()
    const run = runs.get(workspace.path)
    const path = kind === 'crash' ? run?.crashPath : run?.logPath
    if (!path) return { opened: false }
    // Console reads both build logs and .ips crash reports.
    await exec('open', ['-a', 'Console', path]).catch(() => exec('open', [path]))
    return { opened: true }
  })

  orca.panels.handle('run', () => runFocused())
  orca.panels.handle('stop', ({ path }) => stopRun(path))

  orca.panels.handle('worktree.show', async ({ path, terminal }) => {
    const workspace = runWorkspaces.get(path)
    if (!workspace || !canNavigate()) return { shown: false }
    if (terminal) return { shown: await showRunTerminal(path) }
    await orca.host.call('workspace.open', { workspaceId: workspace.id })
    return { shown: true }
  })

  orca.panels.handle('simulator.createForWorktree', async ({ baseUdid }) => {
    const workspace = await ensureFocused()
    const name = worktreeSimulatorName(workspace.name)
    const { devices } = await listDevices()
    let device = devices.find((d) => d.kind === 'simulator' && d.name === name)
    if (!device) {
      const base = devices.find((d) => d.udid === baseUdid)
      if (!base) throw Object.assign(new Error('Base simulator not found'), { code: 'invalid_params' })
      const udid = await createSimulator(name, base)
      device = { ...base, udid, name, state: 'shutdown' }
    }
    await writeConfig(workspace.path, { destination: pickDestination(device) })
    return { state: await publish(), device }
  })
}

/** Answers and posts must be plain JSON: drops keys whose value is `undefined`. */
function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pickDestination(device: Device) {
  return { platform: device.platform, kind: device.kind, udid: device.udid, name: device.name }
}
