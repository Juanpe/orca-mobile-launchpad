// Mobile Launchpad's sidebar panel. A "launch card" says what runs where and how far the build
// got; below it, the destination picker and the build settings. The worker owns all state.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  List,
  ListItem,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Skeleton,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  update,
  type PanelContext
} from 'orca'
import './protocol'
import { preferredScheme } from './platforms/ios-parse'
import {
  isActive,
  worktreeSimulatorName,
  type Device,
  type LaunchpadState,
  type OtherRun,
  type RunPhase,
  type WorkspaceConfig
} from './types'

const state = atom<LaunchpadState | null>(null)
const schemes = atom<string[] | null>(null)
const appSchemes = atom<string[]>([])
/** Advances while a run is in progress: drives the panel's animations. */
const tick = atom(0)

/** The scheme the worker runs when none is chosen, once the schemes are known. */
function autoScheme(s: LaunchpadState): string | undefined {
  const list = read(schemes)
  if (!list || !s.config.project) return undefined
  return preferredScheme(list, s.config.project, read(appSchemes))
}
const schemesError = atom<string | undefined>(undefined)
const devices = atom<Device[] | null>(null)
const devicesError = atom<string | undefined>(undefined)
const busy = atom<string | null>(null)
const error = atom<string | null>(null)
const destinationTab = atom('destinationTab', 'simulators', { persist: 'plugin' })

let schemesFor: string | undefined

async function guarded(label: string, action: () => Promise<unknown>): Promise<void> {
  set(busy, label)
  set(error, null)
  try {
    await action()
  } catch (e) {
    set(error, (e as Error).message)
  } finally {
    set(busy, null)
  }
}

async function loadSchemes(refresh = false): Promise<void> {
  set(schemes, null)
  try {
    const answer = await plugin.request('schemes.list', { refresh }, { timeoutMs: 120_000 })
    set(schemes, answer.schemes)
    set(appSchemes, answer.appSchemes ?? [])
    set(schemesError, answer.error)
  } catch (e) {
    set(schemes, [])
    set(schemesError, (e as Error).message)
  }
}

async function loadDevices(): Promise<void> {
  set(devices, null)
  try {
    const answer = await plugin.request('devices.list', undefined, { timeoutMs: 60_000 })
    set(devices, answer.devices)
    set(devicesError, answer.error)
  } catch (e) {
    set(devices, [])
    set(devicesError, (e as Error).message)
  }
}

/** Saves part of the workspace's config and draws the state the worker answers. */
function updateConfig(label: string, patch: Partial<WorkspaceConfig>): Promise<void> {
  return guarded(label, async () => receive(await plugin.request('config.update', patch)))
}

function receive(next: LaunchpadState): void {
  set(state, next)
  if (next.config.project !== schemesFor) {
    schemesFor = next.config.project
    if (next.config.project) void loadSchemes()
    else set(schemes, [])
  }
}

const ANIMATION_MS = 120
const LAUNCH_CELEBRATION_MS = 5000

export function setup(ctx: PanelContext): void {
  schemesFor = undefined // a new panel run loads its schemes again
  ctx.subscriptions.push(plugin.on('state.changed', receive))
  void plugin.request('state.get').then(receive, (e: Error) => set(error, e.message))
  void loadDevices()
  // Animate only while something moves and the panel is on screen.
  const timer = setInterval(() => {
    const current = read(state)
    if (!current || !read(ctx.visible)) return
    const run = current.run
    const celebrating = run.phase === 'running' && Date.now() - (run.phaseStartedAt ?? 0) < LAUNCH_CELEBRATION_MS
    const elsewhere = current.otherRuns.some((o) => isActive(o.run.phase))
    if (isActive(run.phase) || celebrating || elsewhere) update(tick, (n) => n + 1)
  }, ANIMATION_MS)
  ;(timer as { unref?: () => void }).unref?.() // never keeps a test process alive
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
}

// ── Run status ────────────────────────────────────────────────────────────────────────────────

type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning'

const PHASE: Record<RunPhase, { label: string; tone: Tone }> = {
  idle: { label: 'Ready', tone: 'neutral' },
  preparing: { label: 'Preparing', tone: 'accent' },
  building: { label: 'Building', tone: 'accent' },
  installing: { label: 'Installing', tone: 'accent' },
  launching: { label: 'Launching', tone: 'accent' },
  running: { label: 'Running', tone: 'success' },
  exited: { label: 'Exited', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  crashed: { label: 'Crashed', tone: 'danger' }
}

/** The progress bar's band for each active phase, in percent. */
const BANDS: Partial<Record<RunPhase, [number, number]>> = {
  preparing: [2, 12],
  building: [12, 84],
  installing: [84, 93],
  launching: [93, 99]
}

/** Where the progress bar is now. The build band follows the worktree's last build time when
 *  known, and eases towards its end otherwise, so the bar keeps moving without overshooting. */
export function progressOf(run: LaunchpadState['run'], now: number): number {
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

const STEPS: { phase: RunPhase; label: string }[] = [
  { phase: 'preparing', label: 'Prepare' },
  { phase: 'building', label: 'Build' },
  { phase: 'installing', label: 'Install' },
  { phase: 'launching', label: 'Launch' }
]

/** Prepare ✓ · Build ● · Install ○ · Launch ○ */
function Steps({ phase }: { phase: RunPhase }) {
  const current = STEPS.findIndex((s) => s.phase === phase)
  return (
    <Row gap="xs" wrap>
      {STEPS.map((step, i) => (
        <Badge tone={i < current ? 'success' : i === current ? 'accent' : 'neutral'}>
          {`${i < current ? '✓' : i === current ? '●' : '○'} ${step.label}`}
        </Badge>
      ))}
    </Row>
  )
}

const TRACK = 18

/** A rocket that climbs a track as the build progresses: ━━━━━━🚀┄┄┄┄┄ */
function rocketTrack(progress: number, frame: number): string {
  const position = Math.min(TRACK - 1, Math.floor((progress / 100) * TRACK))
  const flame = frame % 2 ? '·' : '∙'
  return `${'━'.repeat(Math.max(0, position - 1))}${position > 0 ? flame : ''}🚀${'┄'.repeat(TRACK - 1 - position)}`
}

function transportLabel(d: { transport?: 'wifi' | 'cable' }): string {
  return d.transport === 'cable' ? 'Cable' : 'Wi-Fi'
}

function LaunchCard({ s }: { s: LaunchpadState }) {
  const run = s.run
  const phase = PHASE[run.phase]
  const active = isActive(run.phase)
  const live = active || run.phase === 'running'
  const destination = s.config.destination
  const device = read(devices)?.find((d) => d.udid === destination?.udid)
  const project = s.projects.find((p) => p.path === s.config.project) ?? s.projects[0]
  const projectName = project?.label.split('/').pop()?.replace(/\.(xcworkspace|xcodeproj)$/, '')
  // Without a chosen scheme, the worker runs the first app scheme: name it.
  const title = s.config.scheme ?? autoScheme(s) ?? projectName ?? 'App'
  // The branch says which worktree this is; fall back to the worktree's name without one.
  const branch = s.workspace?.branch ? `⎇ ${s.workspace.branch}` : s.workspace?.name ?? ''
  const destinationTitle = destination?.name ?? 'Automatic destination'
  const destinationDetail = !destination
    ? 'The worktree simulator, or a booted one'
    : device
      ? `${device.kind === 'simulator' ? 'Simulator · ' : ''}${deviceDescription(device)}`
      : destination.kind === 'simulator'
        ? 'Simulator'
        : 'iPhone'
  const destinationIcon = device ? deviceIcon(device) : destination?.kind === 'device' ? 'globe' : 'blocks'
  const disabled = read(busy) !== null
  const frame = read(tick)
  const now = Date.now()
  const progress = progressOf(run, now)
  const dots = ['', '.', '..', '...'][Math.floor(frame / 3) % 4]
  const celebrating = run.phase === 'running' && now - (run.phaseStartedAt ?? 0) < LAUNCH_CELEBRATION_MS
  return (
    <Box border={live || run.phase === 'failed' || run.phase === 'crashed' ? phase.tone : true} radius="lg" padding="md" background="card" gap="sm">
      <Stack gap="none">
        <Row justify="between" align="center" gap="sm">
          <Row gap="xs" align="center">
            <Heading level={1}>{title}</Heading>
            <Badge tone="neutral">{s.config.configuration}</Badge>
          </Row>
          <Badge tone={phase.tone}>{`● ${phase.label}`}</Badge>
        </Row>
        <Text muted size="xs" truncate>
          {branch}
        </Text>
      </Stack>

      <List label="Destination">
        <ListItem
          title={destinationTitle}
          description={destinationDetail}
          icon={destinationIcon}
          onPress={() => set(destinationTab, destination?.kind === 'device' ? 'devices' : 'simulators')}
        />
      </List>

      {active ? (
        <Stack gap="xs">
          <Steps phase={run.phase} />
          <Row gap="xs" align="center" justify="between">
            <Row gap="xs" align="center">
              <Spinner label={phase.label} labelHidden />
              <Text size="sm" weight="medium">{`${phase.label}${dots}`}</Text>
            </Row>
            <Text size="xs" muted>
              {`${progress}% · `}
              {run.startedAt ? <RelativeTime at={run.startedAt} format="duration" /> : null}
            </Text>
          </Row>
          <Progress label={phase.label} labelHidden value={progress} />
          <Text size="sm" muted>
            {rocketTrack(progress, frame)}
          </Text>
        </Stack>
      ) : celebrating ? (
        <Stack gap="xs">
          <Text size="sm" weight="semibold" tone="success">
            {`${frame % 4 < 2 ? '🚀' : '✨'} Launched on ${run.destinationName}!`}
          </Text>
          <Progress label="Launched" labelHidden value={100} />
        </Stack>
      ) : run.phase === 'running' && run.startedAt ? (
        <Text size="sm" tone="success">
          {`● Running on ${run.destinationName} · `}
          <RelativeTime at={run.startedAt} format="short" />
        </Text>
      ) : null}

      <Box direction="row" gap="xs" align="stretch">
        <Box grow>
          <Stack align="stretch">
            <Button
              icon={live ? 'refresh' : 'play'}
              variant="solid"
              tone="accent"
              disabled={disabled}
              tooltip="Mod+Alt+R"
              onPress={() => guarded('run', async () => receive(await plugin.request('run', undefined, { timeoutMs: 120_000 })))}
            >
              {live ? 'Relaunch' : 'Build & Run'}
            </Button>
          </Stack>
        </Box>
        {live ? (
          <IconButton
            icon="stop"
            label="Stop"
            tooltip="Stop"
            variant="outline"
            tone="danger"
            disabled={disabled}
            onPress={() => guarded('stop', async () => receive(await plugin.request('stop', {})))}
          />
        ) : null}
      </Box>
    </Box>
  )
}

// ── Other worktrees ───────────────────────────────────────────────────────────────────────────

function OtherRunCard({ other, canNavigate }: { other: OtherRun; canNavigate: boolean }) {
  const { workspace, run } = other
  const phase = PHASE[run.phase]
  const active = isActive(run.phase)
  const live = active || run.phase === 'running'
  read(tick) // redraw with the animation
  const progress = progressOf(run, Date.now())
  const show = (terminal: boolean) =>
    guarded('show', () => plugin.request('worktree.show', { path: workspace.path, terminal }))
  return (
    <Box border={phase.tone === 'neutral' ? true : phase.tone} radius="md" padding="sm" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text weight="semibold" truncate>
          {run.scheme ?? workspace.name}
        </Text>
        <Badge tone={phase.tone}>{`● ${phase.label}`}</Badge>
      </Row>
      <Text muted size="xs" truncate>
        {`⎇ ${workspace.branch || workspace.name} → ${run.destinationName ?? ''}`}
      </Text>
      {active ? (
        <Stack gap="xs">
          <Progress label={`${run.scheme} ${phase.label}`} labelHidden value={progress} />
          <Text size="xs" muted>
            {`${progress}% · `}
            {run.startedAt ? <RelativeTime at={run.startedAt} format="duration" /> : null}
          </Text>
        </Stack>
      ) : run.phase === 'failed' || run.phase === 'crashed' ? (
        <Text size="xs" tone="danger" truncate>
          {run.phase === 'crashed' ? run.crashTitle ?? 'Crashed' : run.errors?.[0] ?? run.message ?? 'Build failed'}
        </Text>
      ) : null}
      <Row gap="xs" wrap>
        {canNavigate ? (
          <Button size="sm" variant="ghost" icon="branch" onPress={() => show(false)}>
            Go to worktree
          </Button>
        ) : null}
        {canNavigate && run.terminalId ? (
          <Button size="sm" variant="ghost" icon="terminal" onPress={() => show(true)}>
            Terminal
          </Button>
        ) : null}
        {live ? (
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            icon="stop"
            onPress={() => guarded('stop', async () => receive(await plugin.request('stop', { path: workspace.path })))}
          >
            Stop
          </Button>
        ) : null}
      </Row>
    </Box>
  )
}

function OtherRuns({ s }: { s: LaunchpadState }) {
  if (s.otherRuns.length === 0) return null
  return (
    <Stack gap="sm">
      <Heading level={3}>{`Other worktrees · ${s.otherRuns.length}`}</Heading>
      {s.otherRuns.map((other) => (
        <OtherRunCard other={other} canNavigate={s.canNavigate} />
      ))}
    </Stack>
  )
}

// ── Failures ──────────────────────────────────────────────────────────────────────────────────

function openLog(kind: 'build' | 'crash'): void {
  void guarded('log', () => plugin.request('log.open', { kind }))
}

function BuildFailure({ run }: { run: LaunchpadState['run'] }) {
  const errors = run.errors ?? []
  return (
    <Callout tone="danger" title="Build failed" icon="error">
      <Stack gap="sm">
        <Text size="sm">{run.message ?? 'Check the build log.'}</Text>
        {errors.length > 0 ? <CodeView label="Errors" code={errors.join('\n')} wrap maxHeight="sm" /> : null}
        {run.logTail ? (
          <Collapsible title="Build log" description="Last lines of xcodebuild's output">
            <CodeView label="Build log" code={run.logTail} wrap lineNumbers maxHeight="md" />
          </Collapsible>
        ) : null}
        {run.logPath ? (
          <Row gap="xs">
            <Button icon="open-external" variant="outline" size="sm" onPress={() => openLog('build')}>
              Open full log in Console
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

function CrashReport({ run }: { run: LaunchpadState['run'] }) {
  return (
    <Callout tone="danger" title={`💥 ${run.scheme ?? 'The app'} crashed`} icon="bug">
      <Stack gap="sm">
        <Text size="sm" weight="medium">{run.crashTitle ?? 'See the crash report.'}</Text>
        {run.crashSummary ? (
          <Collapsible title="Crash report" description="Exception and the crashed thread's frames" defaultOpen>
            <CodeView label="Crash report" code={run.crashSummary} maxHeight="md" />
          </Collapsible>
        ) : null}
        {run.crashPath ? (
          <Row gap="xs">
            <Button icon="open-external" variant="outline" size="sm" onPress={() => openLog('crash')}>
              Open crash report in Console
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

/** A chosen scheme that builds no app (a package or library scheme) cannot be run. */
function SchemeWarning({ s }: { s: LaunchpadState }) {
  const apps = read(appSchemes)
  const scheme = s.config.scheme
  if (!scheme || apps.length === 0 || apps.includes(scheme)) return null
  return (
    <Callout tone="warning" title={`${scheme} doesn't build an app`} icon="warning">
      <Stack gap="xs">
        <Text size="sm">It looks like a library or package scheme, so there is nothing to install.</Text>
        <Row gap="xs" wrap>
          {apps.slice(0, 3).map((app) => (
            <Button size="sm" variant="outline" icon="check" onPress={() => updateConfig('scheme', { scheme: app })}>
              {`Use ${app}`}
            </Button>
          ))}
        </Row>
      </Stack>
    </Callout>
  )
}

// ── Destinations ──────────────────────────────────────────────────────────────────────────────

function deviceDescription(d: Device): string {
  if (d.kind === 'device') {
    return d.state === 'connected' ? `iOS ${d.os} · ${transportLabel(d)}` : `iOS ${d.os} · not connected`
  }
  return d.state === 'booted' ? `iOS ${d.os} · booted` : `iOS ${d.os}`
}

function deviceIcon(d: Device) {
  if (d.kind === 'device') return d.state !== 'connected' ? 'close' : d.transport === 'cable' ? 'plug' : 'globe'
  return d.state === 'booted' ? 'zap' : /iPad/.test(d.name) ? 'layers' : 'blocks'
}

function choose(device: Device): void {
  void updateConfig('destination', {
    destination: { platform: device.platform, kind: device.kind, udid: device.udid, name: device.name }
  })
}

function DeviceList({ label, items, selected }: { label: string; items: Device[]; selected?: string }) {
  return (
    <List label={label}>
      {items.map((d) => (
        <ListItem
          title={d.name}
          description={deviceDescription(d)}
          icon={deviceIcon(d)}
          current={d.udid === selected}
          disabled={d.state === 'unavailable'}
          onPress={() => choose(d)}
        />
      ))}
    </List>
  )
}

function Destinations({ s }: { s: LaunchpadState }) {
  const list = read(devices)
  const listError = read(devicesError)
  const selected = s.config.destination?.udid
  const header = (
    <Row justify="between" align="center">
      <Heading level={3}>Destination</Heading>
      <IconButton icon="refresh" label="Reload devices" variant="ghost" size="sm" onPress={() => loadDevices()} />
    </Row>
  )
  if (list === null) {
    return (
      <Stack gap="sm">
        {header}
        <Skeleton lines={4} label="Looking for devices" />
      </Stack>
    )
  }
  const physical = list.filter((d) => d.kind === 'device')
  const sims = list.filter((d) => d.kind === 'simulator')
  const booted = sims.filter((d) => d.state === 'booted')
  const others = sims.filter((d) => d.state !== 'booted')
  const worktreeSim = s.workspace ? worktreeSimulatorName(s.workspace.name) : ''
  const hasWorktreeSim = sims.some((d) => d.name === worktreeSim)
  const base = sims.find((d) => d.udid === selected) ?? sims.find((d) => /iPhone/.test(d.name)) ?? sims[0]
  const connected = physical.filter((d) => d.state === 'connected').length
  return (
    <Stack gap="sm">
      {header}
      {listError ? (
        <Text tone="warning" size="xs">
          {listError}
        </Text>
      ) : null}
      <Tabs label="Destination" value={read(destinationTab)} onChange={(v) => set(destinationTab, v)}>
        <Tab value="simulators" label={`Simulators · ${sims.length}`} icon="blocks">
          <Stack gap="sm">
            {booted.length > 0 ? <DeviceList label="Booted" items={booted} selected={selected} /> : null}
            {others.length > 0 ? (
              <Collapsible
                title={`Other simulators (${others.length})`}
                defaultOpen={booted.length === 0 || others.some((d) => d.udid === selected)}
              >
                <DeviceList label="Other simulators" items={others} selected={selected} />
              </Collapsible>
            ) : null}
            {!hasWorktreeSim && base && s.workspace ? (
              <Button
                variant="outline"
                icon="add"
                size="sm"
                tooltip={`Creates "${worktreeSim}": a ${base.name} on iOS ${base.os} just for this worktree`}
                disabled={read(busy) !== null}
                onPress={() =>
                  guarded('simulator', async () => {
                    receive((await plugin.request('simulator.createForWorktree', { baseUdid: base.udid })).state)
                    await loadDevices()
                  })
                }
              >
                Simulator for this worktree
              </Button>
            ) : null}
          </Stack>
        </Tab>
        <Tab value="devices" label={`Devices · ${connected}/${physical.length}`} icon="globe">
          {physical.length > 0 ? (
            <DeviceList label="Devices" items={physical} selected={selected} />
          ) : (
            <EmptyState
              icon="globe"
              title="No devices"
              description="Connect your iPhone by cable, or pair it over Wi-Fi in Xcode (Window → Devices and Simulators)."
            />
          )}
        </Tab>
      </Tabs>
    </Stack>
  )
}

// ── Build settings ────────────────────────────────────────────────────────────────────────────

function BuildSettings({ s }: { s: LaunchpadState }) {
  const schemeList = read(schemes)
  const apps = read(appSchemes)
  const schemeOptions = [...(schemeList ?? (s.config.scheme ? [s.config.scheme] : []))]
    .sort((a, b) => Number(apps.includes(b)) - Number(apps.includes(a)))
    .map((x) => ({ value: x, label: apps.includes(x) ? `${x} · app` : x }))
  const configurations = Array.from(new Set(['Debug', 'Release', s.config.configuration]))
  const project = s.projects.find((p) => p.path === s.config.project) ?? s.projects[0]!
  return (
    <Collapsible
      title="Build"
      description={`${project.label} · ${s.config.scheme ?? (autoScheme(s) ? `${autoScheme(s)} (auto)` : 'automatic scheme')} · ${s.config.configuration}`}
    >
      <Stack gap="sm">
        {s.projects.length > 1 ? (
          <Select
            label="Project"
            value={s.config.project}
            options={s.projects.map((p) => ({ value: p.path, label: p.label }))}
            onChange={(value) => updateConfig('project', { project: value })}
          />
        ) : null}
        <Row gap="xs" align="end">
          <Select
            label="Scheme"
            value={s.config.scheme}
            placeholder={schemeList === null ? 'Reading schemes…' : 'Automatic'}
            options={schemeOptions}
            disabled={schemeList === null}
            onChange={(scheme) => updateConfig('scheme', { scheme })}
          />
          <IconButton icon="refresh" label="Reload schemes" variant="ghost" onPress={() => loadSchemes(true)} />
        </Row>
        {read(schemesError) ? (
          <Text tone="warning" size="xs">
            {read(schemesError)}
          </Text>
        ) : null}
        <Select
          label="Configuration"
          value={s.config.configuration}
          options={configurations.map((c) => ({ value: c, label: c }))}
          onChange={(configuration) => updateConfig('configuration', { configuration })}
        />
      </Stack>
    </Collapsible>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────────────────────

export default function Panel() {
  const s = read(state)
  const failure = read(error)
  if (!s) return <Skeleton lines={6} label="Loading" />
  if (!s.workspace) {
    return (
      <Stack gap="md">
        <EmptyState icon="rocket" title="No active worktree" description="Open a worktree with a mobile app." />
        <OtherRuns s={s} />
      </Stack>
    )
  }
  if (s.projects.length === 0) {
    return (
      <Stack gap="md">
        <EmptyState
          icon="rocket"
          title="No mobile app here"
          description={`${s.workspace.name} has no iOS project at its root or in ios/, app/ or mobile/ios.`}
        />
        <OtherRuns s={s} />
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <LaunchCard s={s} />
      <SchemeWarning s={s} />
      {s.run.phase === 'failed' ? <BuildFailure run={s.run} /> : null}
      {s.run.phase === 'crashed' ? <CrashReport run={s.run} /> : null}
      <OtherRuns s={s} />
      {failure ? (
        <Callout tone="danger" title="Error" icon="error">
          <Text size="sm">{failure}</Text>
        </Callout>
      ) : null}
      <BuildSettings s={s} />
      <Destinations s={s} />
    </Stack>
  )
}
