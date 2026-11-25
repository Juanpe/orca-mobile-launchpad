// Mobile Launchpad's worker: follows the focused workspace, keeps each workspace's run config, drives
// the status bar item, and runs builds in an Orca terminal of that workspace.
import { progressOf } from './progress'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { exec, shellQuote } from './exec'
import { CLI_SCRIPT, parseRequest, type CliRequest } from './cli'
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

  /** Orca refuses status bar text over 64 characters: shorten the middle (the device name). */
  function fitStatusText(text: string): string {
    const MAX = 64
    if (text.length <= MAX) return text
    return `${text.slice(0, MAX - 1)}…`
  }

  async function updateStatusBar(s: LaunchpadState): Promise<void> {
    const elsewhere = s.otherRuns.filter((o) => isActive(o.run.phase)).length
    // Short: it is appended to the focused worktree's own text.
    const elsewhereText = elsewhere ? `${SPINNER[spinFrame]} +${elsewhere} elsewhere` : ''
    if (!s.workspace || s.projects.length === 0) {
      // Nothing to run here, but keep showing builds that go on in other worktrees.
      await orca.host.call(
        'statusBar.update',
        elsewhere
          ? { id: STATUS_ITEM, visible: true, text: `${SPINNER[spinFrame]} ${elsewhere} building elsewhere`, icon: 'hammer', tone: 'accent', tooltip: s.otherRuns.map((o) => `${o.run.scheme} · ${o.workspace.name}`).join('\n') }
          : { id: STATUS_ITEM, visible: false }
      )
      return
    }
    // "Juanpe’s iPhone 18 Pro" → "iPhone 18 Pro": the owner's name costs status bar room.
    const target = (s.config.destination?.name ?? 'choose a destination').replace(/^.*?[’']s\s+/, '')
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
    await orca.host.call('statusBar.update', { id: STATUS_ITEM, visible: true, ...item, text: fitStatusText(item.text) })
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
    saveRuns()
    settleWaiters(path, run)
  }

  // Runs outlive the worker (a reinstall, a reload): keep them in storage to pick them up again.
  const RUNS_KEY = 'runs'
  let saving: Promise<unknown> = Promise.resolve()
  function saveRuns(): void {
    const entries = [...runs].flatMap(([path, run]) => {
      const workspace = runWorkspaces.get(path)
      return workspace ? [{ path, run, workspace }] : []
    })
    saving = saving.then(() => orca.storage.set(RUNS_KEY, toJson(entries))).catch((e) => orca.log(`save runs: ${(e as Error).message}`))
  }

  /** Brings back the runs of an earlier worker: those still alive resume, the rest get their last phase. */
  async function restoreRuns(): Promise<void> {
    const stored = (await orca.storage.get(RUNS_KEY).catch(() => null)) as { path: string; run: RunState; workspace: WorkspaceInfo }[] | null
    for (const { path, run, workspace } of stored ?? []) {
      if (runs.has(path)) continue
      runWorkspaces.set(path, workspace)
      const statusFile = await fileFor(path, 'status')
      const ongoing = isActive(run.phase) || run.phase === 'running'
      if (ongoing && run.pid && isAlive(run.pid)) {
        runs.set(path, run)
        startPolling(workspace, statusFile)
        continue
      }
      if (ongoing) {
        // It ended while no worker watched: its status file says how.
        const raw = (await readFile(statusFile, 'utf8').catch(() => '')).trim()
        const word = raw.split(':')[0] as RunPhase
        const ended = ['failed', 'exited', 'crashed', 'stopped'].includes(word) ? word : 'stopped'
        runs.set(path, { ...run, phase: ended, finishedAt: run.finishedAt ?? Date.now() })
      } else {
        runs.set(path, run)
      }
    }
    saveRuns()
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
          command: await followCommand(run.outPath, run.pid ?? 0)
        })
      ).terminalId
      setRun(path, { ...run, terminalId })
    }
    return (await orca.host.call('terminal.focus', { terminalId: terminalId! })).focused
  }

  type Overrides = { destination?: Device; scheme?: string; configuration?: string }

  /** The config a worktree runs with: its saved one, its first project, and the scheme and
   *  destination picked automatically when none is chosen; `overrides` are saved as well. */
  async function runConfig(workspace: WorkspaceInfo, projects: ProjectRef[], overrides: Overrides = {}): Promise<WorkspaceConfig> {
    let config = await readConfig(workspace.path)
    if (!config.project || !projects.some((p) => p.path === config.project)) {
      if (!projects[0]) throw Object.assign(new Error('No Xcode project found in this worktree'), { code: 'action_failed' })
      config = await writeConfig(workspace.path, { project: projects[0].path, scheme: undefined })
    }
    const patch: Partial<WorkspaceConfig> = {}
    if (overrides.scheme) patch.scheme = overrides.scheme
    if (overrides.configuration) patch.configuration = overrides.configuration
    if (overrides.destination) patch.destination = pickDestination(overrides.destination)
    if (Object.keys(patch).length) config = await writeConfig(workspace.path, patch)
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
    return config
  }

  /** Builds and runs a worktree's app: the panel's Build & Run, the status bar and `launchpad run`. */
  async function launch(workspace: WorkspaceInfo, projects: ProjectRef[], overrides: Overrides = {}): Promise<RunState> {
    const config = await runConfig(workspace, projects, overrides)
    const previous = runs.get(workspace.path)
    if (previous) settleWaiters(workspace.path, { ...previous, phase: 'stopped', message: 'A new run replaced it' })
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
      command: await followCommand(outFile, pid)
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
    return runs.get(workspace.path)!
  }

  async function runFocused(): Promise<LaunchpadState> {
    const workspace = await ensureFocused()
    await launch(workspace, focusedProjects)
    return publish()
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

  // ── The `launchpad` command ─────────────────────────────────────────────────────────────────
  // Requests arrive as files in a private folder; see src/cli.ts.

  const waiters = new Map<string, string[]>() // worktree path → requests waiting for the run's outcome
  const ENDINGS: RunPhase[] = ['running', 'exited', 'failed', 'crashed', 'stopped']
  const inboxDir = async () => join(await workDir(), 'requests')

  /** Writes a file of shell assignments the command sources; renamed into place whole. */
  async function answer(file: string, values: Record<string, string | number | undefined>): Promise<void> {
    const dir = await inboxDir()
    const body = Object.entries(values)
      .map(([key, value]) => `${key}=${shellQuote(String(value ?? ''))}`)
      .join('\n')
    await writeFile(join(dir, `.${file}`), `${body}\n`, { mode: 0o600 })
    await rename(join(dir, `.${file}`), join(dir, file))
  }

  function settleWaiters(path: string, run: RunState): void {
    const ids = waiters.get(path)
    if (!ids?.length || !ENDINGS.includes(run.phase)) return
    waiters.delete(path)
    for (const id of ids) {
      void answer(`done-${id}.sh`, {
        PHASE: run.phase,
        MESSAGE: run.message,
        ERRORS: (run.errors ?? []).join('\n'),
        CRASH_TITLE: run.crashTitle,
        CRASH_PATH: run.crashPath,
        LOG_FILE: run.logPath
      }).catch((e) => orca.log(`launchpad answer: ${(e as Error).message}`))
    }
  }

  /** The Orca worktree that holds `cwd`: the deepest one, so a nested worktree wins. */
  async function worktreeAt(cwd: string): Promise<WorkspaceInfo> {
    const real = await realpath(cwd).catch(() => cwd)
    const { workspaces } = await orca.host.call('workspace.list')
    let best: { id: string; name: string; branch?: string | null; path: string } | undefined
    for (const w of workspaces) {
      for (const p of [w.path, await realpath(w.path).catch(() => w.path)]) {
        if ((real === p || real.startsWith(`${p}/`)) && (!best || p.length > best.path.length)) best = { ...w, path: w.path }
      }
    }
    if (!best) throw new Error(`${cwd} is not inside an Orca worktree`)
    return { id: best.id, name: best.name, branch: best.branch ?? '', path: best.path }
  }

  /** The device `--device NAME` / `--simulator NAME` means. */
  function destinationFor(devices: Device[], workspace: WorkspaceInfo, request: CliRequest): Device | undefined {
    if (request.device !== undefined) {
      const query = request.device.toLowerCase()
      const iphones = devices.filter((d) => d.kind === 'device' && d.name.toLowerCase().includes(query))
      const pick = iphones.find((d) => d.state === 'connected') ?? iphones[0]
      if (!pick) {
        const names = devices.filter((d) => d.kind === 'device').map((d) => d.name)
        throw new Error(`No iPhone matches "${request.device}"${names.length ? ` (known: ${names.join(', ')})` : ''}`)
      }
      if (pick.state !== 'connected') throw new Error(`${pick.name} is not connected (plug it in, or join its Wi-Fi)`)
      return pick
    }
    if (request.simulator !== undefined) {
      const query = request.simulator.toLowerCase()
      const sims = devices.filter((d) => d.kind === 'simulator' && d.name.toLowerCase().includes(query))
      const pick = query ? sims.find((d) => d.state === 'booted') ?? sims[0] : preferredDestination(sims, worktreeSimulatorName(workspace.name))
      if (!pick) throw new Error(`No simulator matches "${request.simulator}"`)
      return pick
    }
    return undefined
  }

  const PHASE_WORDS: Record<RunPhase, string> = {
    idle: 'no run yet',
    preparing: 'preparing',
    building: 'building',
    installing: 'installing',
    launching: 'launching',
    running: 'running',
    exited: 'the app exited',
    stopped: 'stopped',
    failed: 'failed',
    crashed: 'crashed'
  }

  async function handleRequest(id: string, request: CliRequest): Promise<void> {
    try {
      if (request.cmd === 'devices') {
        const { devices, error } = await listDevices()
        const rows = devices.map((d) => `${d.kind === 'device' ? 'iPhone   ' : 'simulator'}  ${d.name} · ${d.kind === 'device' ? (d.state === 'connected' ? `iOS ${d.os} · ${d.transport === 'cable' ? 'cable' : 'Wi-Fi'}` : 'not connected') : `iOS ${d.os}${d.state === 'booted' ? ' · booted' : ''}`}`)
        await answer(`res-${id}.sh`, { OK: 1, DEVICES: rows.join('\n') || error || 'No simulators or devices' })
        return
      }
      const workspace = await worktreeAt(request.cwd ?? '/')
      if (request.cmd === 'status') {
        const run = runs.get(workspace.path) ?? { phase: 'idle' as const }
        const detail =
          run.phase === 'failed' ? [run.message, ...(run.errors ?? [])].filter(Boolean).join('\n')
          : run.phase === 'crashed' ? run.crashTitle
          : run.scheme ? `${run.scheme} → ${run.destinationName}` : ''
        await answer(`res-${id}.sh`, { OK: 1, WORKSPACE: workspace.name, PHASE_LABEL: PHASE_WORDS[run.phase], DETAIL: detail })
        return
      }
      if (request.cmd === 'stop') {
        const run = runs.get(workspace.path)
        const live = !!run && (isActive(run.phase) || run.phase === 'running')
        await stopRun(workspace.path)
        await answer(`res-${id}.sh`, { OK: 1, MESSAGE: live ? `Stopped ${run!.scheme} in ${workspace.name}` : `Nothing runs in ${workspace.name}` })
        return
      }
      const projects = workspace.path === focused?.path ? focusedProjects : await findProjects(workspace.path)
      const wantsDevice = request.device !== undefined || request.simulator !== undefined
      const destination = wantsDevice ? destinationFor((await listDevices()).devices, workspace, request) : undefined
      const run = await launch(workspace, projects, { destination, scheme: request.scheme, configuration: request.configuration })
      waiters.set(workspace.path, [...(waiters.get(workspace.path) ?? []), id])
      const config = await readConfig(workspace.path)
      await publish()
      await answer(`res-${id}.sh`, {
        OK: 1,
        WORKSPACE: workspace.name,
        SCHEME: run.scheme,
        CONFIGURATION: config.configuration,
        DESTINATION: run.destinationName,
        STATUS_FILE: await fileFor(workspace.path, 'status'),
        OUT_FILE: run.outPath,
        LOG_FILE: run.logPath
      })
    } catch (e) {
      await answer(`res-${id}.sh`, { OK: 0, ERROR: (e as Error).message })
    }
  }

  /** Writes the command, then looks for requests every second and marks itself alive. */
  async function startInbox(): Promise<void> {
    const dir = await inboxDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const cli = join(await workDir(), 'launchpad')
    await writeFile(cli, `#!/bin/bash\n# launchpad: written by the Mobile Launchpad Orca plugin each time it starts.\nREQ_DIR=${shellQuote(dir)}\n${CLI_SCRIPT}`, 'utf8')
    await chmod(cli, 0o755)
    const alive = join(dir, '.alive')
    let busy = false
    every(POLL_MS, async () => {
      if (busy) return
      busy = true
      try {
        const now = new Date()
        await utimes(alive, now, now).catch(() => writeFile(alive, ''))
        for (const name of await readdir(dir)) {
          const match = /^req-([\w-]+)\.txt$/.exec(name)
          if (!match) continue
          const file = join(dir, name)
          const text = await readFile(file, 'utf8').catch(() => '')
          await rm(file, { force: true })
          const request = parseRequest(text)
          if (request) void handleRequest(match[1]!, request)
          else await answer(`res-${match[1]}.sh`, { OK: 0, ERROR: 'Unreadable request' })
        }
      } catch (e) {
        orca.log(`launchpad inbox: ${(e as Error).message}`)
      } finally {
        busy = false
      }
    })
  }

  void restoreRuns()
    .then(() => publish())
    .catch((e) => orca.log(`restore runs: ${(e as Error).message}`))
  void startInbox().catch((e) => orca.log(`launchpad inbox: ${(e as Error).message}`))

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
