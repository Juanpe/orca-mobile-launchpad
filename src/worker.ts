// Launchpad's worker: follows the focused workspace, keeps each workspace's run config, drives
// the status bar item, and runs builds in an Orca terminal of that workspace.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol'
import {
  createSimulator,
  findProjects,
  listDevices,
  listSchemes,
  prepareRunCommand,
  workDir
} from './platforms/ios'
import { preferredDestination, preferredScheme } from './platforms/ios-parse'
import {
  isActive,
  worktreeSimulatorName,
  type Device,
  type LaunchpadState,
  type ProjectRef,
  type RunPhase,
  type RunState,
  type WorkspaceConfig,
  type WorkspaceInfo
} from './types'

const STATUS_ITEM = 'run'
const POLL_MS = 1000
const DEFAULT_CONFIG: WorkspaceConfig = { configuration: 'Debug' }

type Context = { workspaceId?: string; branch: string; displayName: string } | null

export default function activate(orca: OrcaWorkerApi): void {
  let focused: WorkspaceInfo | null = null
  let focusedProjects: ProjectRef[] = []
  const runs = new Map<string, RunState>() // by workspace path
  const pollers = new Map<string, ReturnType<typeof setInterval>>()
  const schemeCache = new Map<string, string[]>()

  const configKey = (path: string) => `config:${path}`
  const statusFileFor = async (path: string) =>
    join(await workDir(), `status-${createHash('sha1').update(path).digest('hex').slice(0, 12)}.txt`)

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

  async function state(): Promise<LaunchpadState> {
    if (!focused) return { workspace: null, projects: [], config: DEFAULT_CONFIG, run: { phase: 'idle' } }
    let config = await readConfig(focused.path)
    if (!config.project || !focusedProjects.some((p) => p.path === config.project)) {
      if (focusedProjects[0]) config = await writeConfig(focused.path, { project: focusedProjects[0].path, scheme: undefined })
    }
    return {
      workspace: focused,
      projects: focusedProjects,
      config,
      run: runs.get(focused.path) ?? { phase: 'idle' }
    }
  }

  async function publish(): Promise<LaunchpadState> {
    const s = await state()
    orca.panels.post('state.changed', s)
    await updateStatusBar(s).catch((e) => orca.log(`statusBar.update: ${(e as Error).message}`))
    return s
  }

  async function updateStatusBar(s: LaunchpadState): Promise<void> {
    if (!s.workspace || s.projects.length === 0) {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, visible: false })
      return
    }
    const target = s.config.destination?.name ?? 'elegir destino'
    const scheme = s.config.scheme ?? s.projects[0]?.label.split('/').pop()?.replace(/\.\w+$/, '')
    const run = s.run
    const labels: Partial<Record<RunPhase, string>> = {
      preparing: 'Preparando',
      building: 'Compilando',
      installing: 'Instalando',
      launching: 'Lanzando'
    }
    let item: { text: string; icon: 'rocket' | 'hammer' | 'play' | 'error' | 'stop'; tone: 'neutral' | 'accent' | 'success' | 'danger'; tooltip: string }
    if (isActive(run.phase)) {
      item = { text: `${labels[run.phase]}… · ${target}`, icon: 'hammer', tone: 'accent', tooltip: `${run.scheme} → ${target}. Pulsa para relanzar.` }
    } else if (run.phase === 'running') {
      item = { text: `${run.scheme} · ${target}`, icon: 'play', tone: 'success', tooltip: `Ejecutándose en ${target}. Pulsa para recompilar y relanzar.` }
    } else if (run.phase === 'failed') {
      item = { text: `Falló · ${target}`, icon: 'error', tone: 'danger', tooltip: `${run.message ?? 'Build fallido'}. Pulsa para reintentar.` }
    } else {
      item = { text: `${scheme ?? 'Run'} · ${target}`, icon: 'rocket', tone: 'neutral', tooltip: `Build & Run de ${s.workspace.name} en ${target}` }
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
    if (!focused) throw Object.assign(new Error('No hay ningún workspace activo'), { code: 'action_failed' })
    return focused
  }

  async function schemesFor(project: string, refresh = false): Promise<string[]> {
    if (!refresh && schemeCache.has(project)) return schemeCache.get(project)!
    const schemes = await listSchemes(project)
    schemeCache.set(project, schemes)
    return schemes
  }

  function setRun(path: string, run: RunState): void {
    runs.set(path, run)
    if (!isActive(run.phase) && run.phase !== 'running') stopPolling(path)
  }

  function stopPolling(path: string): void {
    const timer = pollers.get(path)
    if (timer) clearInterval(timer)
    pollers.delete(path)
  }

  function startPolling(workspace: WorkspaceInfo, statusFile: string): void {
    stopPolling(workspace.path)
    let ticks = 0
    let last = ''
    const timer = setInterval(async () => {
      ticks++
      const run = runs.get(workspace.path)
      if (!run) return stopPolling(workspace.path)
      // The person may close the terminal: then nothing writes the status file again.
      if (ticks % 5 === 0 && run.terminalId) {
        const alive = await orca.host
          .call('terminal.list', { workspaceId: workspace.id })
          .then((r) => r.terminals.some((t) => t.id === run.terminalId))
          .catch(() => true)
        if (!alive) {
          setRun(workspace.path, { ...run, phase: 'stopped', finishedAt: Date.now(), terminalId: undefined })
          await publish()
          return
        }
      }
      const raw = (await readFile(statusFile, 'utf8').catch(() => '')).trim()
      if (!raw || raw === last) return
      last = raw
      const [word, ...rest] = raw.split(':')
      const phase = word as RunPhase
      const message = rest.join(':') || undefined
      const finished = phase === 'failed' || phase === 'exited' || phase === 'stopped'
      setRun(workspace.path, { ...run, phase, message, finishedAt: finished ? Date.now() : undefined })
      if (phase === 'failed') {
        void notify(`${run.scheme}: ${message ?? 'falló'}`, workspace.name)
      } else if (phase === 'running') {
        void notify(`${run.scheme} se está ejecutando en ${run.destinationName}`, workspace.name)
      }
      await publish()
    }, POLL_MS)
    pollers.set(workspace.path, timer)
  }

  async function notify(body: string, title: string): Promise<void> {
    await orca.host.call('notifications.show', { title: `Launchpad · ${title}`, body }).catch(() => undefined)
  }

  async function closeRunTerminal(path: string): Promise<void> {
    const run = runs.get(path)
    if (run?.terminalId) {
      await orca.host.call('terminal.close', { terminalId: run.terminalId }).catch(() => undefined)
    }
  }

  async function runFocused(): Promise<LaunchpadState> {
    const workspace = await ensureFocused()
    let s = await state()
    if (!s.config.project) throw Object.assign(new Error('No encuentro ningún proyecto de Xcode en este worktree'), { code: 'action_failed' })
    let config = s.config
    if (!config.scheme) {
      const scheme = preferredScheme(await schemesFor(config.project!), config.project!)
      if (!scheme) throw Object.assign(new Error('El proyecto no tiene schemes compartidos'), { code: 'action_failed' })
      config = await writeConfig(workspace.path, { scheme })
    }
    if (!config.destination) {
      const { devices } = await listDevices()
      const device = preferredDestination(devices, worktreeSimulatorName(workspace.name))
      if (!device) throw Object.assign(new Error('No hay simuladores ni dispositivos disponibles'), { code: 'action_failed' })
      config = await writeConfig(workspace.path, { destination: pickDestination(device) })
    }
    await closeRunTerminal(workspace.path)
    const statusFile = await statusFileFor(workspace.path)
    await writeFile(statusFile, 'preparing\n', 'utf8')
    const command = await prepareRunCommand({
      projectPath: config.project!,
      scheme: config.scheme!,
      configuration: config.configuration,
      destination: config.destination!,
      statusFile,
      openSimulatorApp: true
    })
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId: workspace.id,
      title: `▶ ${config.scheme}`,
      command
    })
    setRun(workspace.path, {
      phase: 'preparing',
      startedAt: Date.now(),
      terminalId,
      scheme: config.scheme,
      destinationName: config.destination!.name
    })
    startPolling(workspace, statusFile)
    s = await publish()
    return s
  }

  async function stopFocused(): Promise<LaunchpadState> {
    const workspace = await ensureFocused()
    const run = runs.get(workspace.path)
    await closeRunTerminal(workspace.path)
    if (run) setRun(workspace.path, { ...run, phase: 'stopped', finishedAt: Date.now(), terminalId: undefined })
    return publish()
  }

  // Status bar press, palette and shortcut.
  orca.commands.register('launchpad.run', async () => {
    try {
      const s = await runFocused()
      return `Build & Run: ${s.config.scheme} → ${s.config.destination?.name}`
    } catch (e) {
      const message = (e as Error).message
      await notify(message, focused?.name ?? 'Launchpad')
      return message
    }
  })
  orca.commands.register('launchpad.stop', async () => {
    await stopFocused()
    return 'Detenido'
  })

  orca.events.on('workspace.changed', ({ context }) => focus(context))

  orca.panels.handle('state.get', async () => {
    if (!focused) await focus(await orca.host.call('workspace.readContext'))
    return state()
  })

  orca.panels.handle('schemes.list', async ({ refresh }) => {
    const s = await state()
    if (!s.config.project) return { schemes: [] }
    try {
      return { schemes: await schemesFor(s.config.project, refresh) }
    } catch (e) {
      return { schemes: [], error: (e as Error).message }
    }
  })

  orca.panels.handle('devices.list', () => listDevices())

  orca.panels.handle('config.update', async (patch) => {
    const workspace = await ensureFocused()
    // A new project invalidates the scheme picked for the old one.
    const clean = patch.project !== undefined && !('scheme' in patch) ? { ...patch, scheme: undefined } : patch
    await writeConfig(workspace.path, clean)
    return publish()
  })

  orca.panels.handle('run', () => runFocused())
  orca.panels.handle('stop', () => stopFocused())

  orca.panels.handle('simulator.createForWorktree', async ({ baseUdid }) => {
    const workspace = await ensureFocused()
    const name = worktreeSimulatorName(workspace.name)
    const { devices } = await listDevices()
    let device = devices.find((d) => d.kind === 'simulator' && d.name === name)
    if (!device) {
      const base = devices.find((d) => d.udid === baseUdid)
      if (!base) throw Object.assign(new Error('No encuentro el simulador base'), { code: 'invalid_params' })
      const udid = await createSimulator(name, base)
      device = { ...base, udid, name, state: 'shutdown' }
    }
    await writeConfig(workspace.path, { destination: pickDestination(device) })
    return { state: await publish(), device }
  })
}

function pickDestination(device: Device) {
  return { platform: device.platform, kind: device.kind, udid: device.udid, name: device.name }
}
