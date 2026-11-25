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
import { preferredModule } from './platforms/android-parse'
import { progressOf } from './progress'
export { progressOf } from './progress'
import {
  isActive,
  worktreeSimulatorName,
  type Device,
  type LaunchpadState,
  type OtherRun,
  type Platform,
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
  return platformOf(s) === 'android' ? preferredModule(read(appSchemes)) : preferredScheme(list, s.config.project, read(appSchemes))
}

/** The platform of the worktree's chosen project. */
function platformOf(s: LaunchpadState): Platform {
  return (s.projects.find((p) => p.path === s.config.project) ?? s.projects[0])?.platform ?? 'ios'
}

/** How a scheme or module reads: Android's `:app` is the app itself, named by the Gradle build. */
function targetLabel(s: LaunchpadState, target: string): string {
  if (!target.startsWith(':')) return target
  const project = s.projects.find((p) => p.path === s.config.project)
  return target === ':app' && project?.name ? project.name : target.slice(1)
}

/** Configurations (iOS) or build variants (Android) the worker offers for the project. */
const configurations = atom<string[] | null>(null)
const schemesError = atom<string | undefined>(undefined)
const devices = atom<Device[] | null>(null)
const devicesError = atom<string | undefined>(undefined)
const busy = atom<string | null>(null)
const error = atom<string | null>(null)
const destinationTab = atom('destinationTab', 'simulators', { persist: 'plugin' })
/** Whether the destination picker under the launch card is open; the card's chip toggles it. */
const pickerOpen = atom('pickerOpen', true, { persist: 'plugin' })

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
    set(configurations, answer.configurations?.length ? answer.configurations : null)
    set(schemesError, answer.error)
  } catch (e) {
    set(schemes, [])
    set(schemesError, (e as Error).message)
  }
}

async function loadDevices(quiet = false): Promise<void> {
  // A quiet reload keeps the current list on screen while it asks again.
  if (!quiet) set(devices, null)
  try {
    const answer = await plugin.request('devices.list', undefined, { timeoutMs: 60_000 })
    set(devices, answer.devices)
    set(devicesError, answer.error)
  } catch (e) {
    if (quiet) return // keep what is shown; the next round tries again
    set(devices, [])
    set(devicesError, (e as Error).message)
  }
}

/** How often the panel looks for devices plugged in, unplugged, booted or switched to cable. */
const DEVICES_POLL_MS = 3000

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
  // Keep the destination list current while the panel is on screen (both lists take ~0.1s).
  let polling = false
  const devicesTimer = setInterval(() => {
    if (polling || !read(ctx.visible) || read(devices) === null) return
    polling = true
    void loadDevices(true).finally(() => {
      polling = false
    })
  }, DEVICES_POLL_MS)
  ;(devicesTimer as { unref?: () => void }).unref?.()
  ctx.signal.addEventListener('abort', () => {
    clearInterval(timer)
    clearInterval(devicesTimer)
  })
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

const STEPS: { phase: RunPhase; label: string }[] = [
  { phase: 'preparing', label: 'Prepare' },
  { phase: 'building', label: 'Build' },
  { phase: 'installing', label: 'Install' },
  { phase: 'launching', label: 'Launch' }
]

/** "Step 2 of 4" while a run is in one of its steps. */
function stepOf(phase: RunPhase): string {
  const i = STEPS.findIndex((step) => step.phase === phase)
  return i < 0 ? '' : `Step ${i + 1} of ${STEPS.length}`
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
  const target = s.config.scheme ?? autoScheme(s)
  const title = target ? targetLabel(s, target) : project?.name ?? projectName ?? 'App'
  const platform = platformOf(s)
  const platforms = Array.from(new Set(s.projects.map((p) => p.platform)))
  // The branch says which worktree this is; fall back to the worktree's name without one.
  const branch = s.workspace?.branch ? `⎇ ${s.workspace.branch}` : s.workspace?.name ?? ''
  // "Juanpe’s iPhone 18 Pro" → "iPhone 18 Pro": the chip is narrow.
  const shortName = destination?.name.replace(/^.*?[’']s\s+/, '')
  const how = !destination
    ? undefined
    : device?.kind === 'device'
      ? device.state === 'connected' ? transportLabel(device) : 'offline'
      : destination.kind === 'simulator'
        ? device?.state === 'booted' ? (platform === 'android' ? 'running' : 'booted') : platform === 'android' ? 'emulator' : 'sim'
        : undefined
  const chipText = `${shortName ?? 'Automatic'}${how ? ` · ${how}` : ''} ${read(pickerOpen) ? '▴' : '▾'}`
  const chipIcon = device ? deviceIcon(device) : destination?.kind === 'device' ? 'globe' : 'blocks'
  const chipTooltip = !destination
    ? 'No destination chosen: runs on the worktree simulator or a booted one. Choose one.'
    : `${destination.name}${device ? ` · ${deviceDescription(device)}` : ''}. Change destination.`
  const disabled = read(busy) !== null
  const frame = read(tick)
  const now = Date.now()
  const progress = progressOf(run, now)
  const celebrating = run.phase === 'running' && now - (run.phaseStartedAt ?? 0) < LAUNCH_CELEBRATION_MS
  return (
    <Box border={live || run.phase === 'failed' || run.phase === 'crashed' ? phase.tone : true} radius="lg" padding="md" background="card" gap="sm">
      {platforms.length > 1 ? (
        <Row gap="xs">
          {platforms.map((p) => (
            <Button
              size="sm"
              variant={p === platform ? 'solid' : 'ghost'}
              disabled={read(busy) !== null || p === platform}
              onPress={() => updateConfig('platform', { project: s.projects.find((x) => x.platform === p)!.path })}
            >
              {p === 'ios' ? '🍏 iOS' : '🤖 Android'}
            </Button>
          ))}
        </Row>
      ) : null}
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <Heading level={1}>{title}</Heading>
          <Badge tone="neutral">{s.config.configuration}</Badge>
        </Row>
        <Badge tone={phase.tone}>{phase.label}</Badge>
      </Row>

      <Box direction="row" gap="xs" align="center">
        <Box grow>
          <Stack align="stretch">
            <Button icon={chipIcon} variant="outline" tooltip={chipTooltip} onPress={() => update(pickerOpen, (open) => !open)}>
              {chipText}
            </Button>
          </Stack>
        </Box>
        {live ? (
          <IconButton
            icon="refresh"
            label="Relaunch"
            tooltip="Relaunch (Mod+Alt+R)"
            variant="solid"
            tone="accent"
            disabled={disabled}
            onPress={() => guarded('run', async () => receive(await plugin.request('run', undefined, { timeoutMs: 120_000 })))}
          />
        ) : (
          <Button
            icon="play"
            variant="solid"
            tone="accent"
            disabled={disabled}
            tooltip="Build & Run (Mod+Alt+R)"
            onPress={() => guarded('run', async () => receive(await plugin.request('run', undefined, { timeoutMs: 120_000 })))}
          >
            Run
          </Button>
        )}
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

      {active ? (
        <Stack gap="xs">
          <Row gap="xs" align="center" justify="between">
            <Row gap="xs" align="center">
              <Spinner label={phase.label} labelHidden />
              <Text size="sm" muted>
                {stepOf(run.phase)}
              </Text>
            </Row>
            <Text size="xs" muted>
              {`${progress}% · `}
              {run.startedAt ? <RelativeTime at={run.startedAt} format="duration" /> : null}
            </Text>
          </Row>
          <Progress label={phase.label} labelHidden value={progress} />
        </Stack>
      ) : celebrating ? (
        <Text size="sm" weight="semibold" tone="success">
          {`${frame % 4 < 2 ? '🚀' : '✨'} Launched on ${run.destinationName}!`}
        </Text>
      ) : run.phase === 'running' && run.startedAt ? (
        <Text size="sm" tone="success">
          {'Running for '}
          <RelativeTime at={run.startedAt} format="short" />
        </Text>
      ) : null}

      <Text muted size="xs" truncate>
        {branch}
      </Text>
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
        <Row gap="xs" align="center">
          <Text weight="semibold" truncate>
            {run.scheme ?? workspace.name}
          </Text>
          {run.platform ? <Badge>{run.platform === 'ios' ? '🍏 iOS' : '🤖 Android'}</Badge> : null}
        </Row>
        <Badge tone={phase.tone}>{phase.label}</Badge>
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
        <Text size="sm">
          {platformOf(s) === 'android'
            ? 'It is a library module, so there is nothing to install.'
            : 'It looks like a library or package scheme, so there is nothing to install.'}
        </Text>
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
  if (d.platform === 'android') {
    const os = !d.os || /^API /.test(d.os) ? d.os || 'Android' : `Android ${d.os}`
    if (d.kind === 'device') return d.state === 'connected' ? `${os} · ${transportLabel(d)}` : d.os === 'unauthorized' ? 'allow USB debugging on the phone' : 'not connected'
    return d.state === 'booted' ? `${os} · running` : os
  }
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
  // Like a dropdown: picking closes the picker; the card's chip opens it again.
  void updateConfig('destination', {
    destination: { platform: device.platform, kind: device.kind, udid: device.udid, name: device.name }
  }).then(() => set(pickerOpen, false))
}

function DeviceList({ label, items, selected }: { label: string; items: Device[]; selected?: string }) {
  const row = (d: Device) => (
    <ListItem
      title={d.name}
      description={deviceDescription(d)}
      icon={deviceIcon(d)}
      disabled={d.state === 'unavailable'}
      onPress={() => choose(d)}
    />
  )
  // The chosen row sits in an accent-tinted Box instead of ListItem's grey `current` fill. A List
  // holds only ListItems, so the list splits around it: rows before, the chosen one, rows after.
  const at = items.findIndex((d) => d.udid === selected)
  if (at < 0) return <List label={label}>{items.map(row)}</List>
  const before = items.slice(0, at)
  const after = items.slice(at + 1)
  return (
    <Stack gap="none">
      {before.length ? <List label={label}>{before.map(row)}</List> : null}
      <Box background="accent" radius="md">
        <List label={before.length ? `${label}, selected` : label}>{row(items[at]!)}</List>
      </Box>
      {after.length ? <List label={`${label}, more`}>{after.map(row)}</List> : null}
    </Stack>
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
  const platform = platformOf(s)
  const android = platform === 'android'
  const mine = list.filter((d) => d.platform === platform)
  const physical = mine.filter((d) => d.kind === 'device')
  const sims = mine.filter((d) => d.kind === 'simulator')
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
        <Tab value="simulators" label={`💻 ${android ? 'Emulators' : 'Simulators'} · ${sims.length}`}>
          <Stack gap="sm">
            {booted.length > 0 ? <DeviceList label={android ? 'Running' : 'Booted'} items={booted} selected={selected} /> : null}
            {android && sims.length === 0 ? (
              <EmptyState icon="blocks" title="No emulators" description="Create one in Android Studio (Device Manager)." />
            ) : null}
            {others.length > 0 ? (
              <Collapsible
                title={`${booted.length ? 'Other ' : ''}${android ? 'emulators' : 'simulators'} (${others.length})`}
                defaultOpen={booted.length === 0 || others.some((d) => d.udid === selected)}
              >
                <DeviceList label={android ? 'Other emulators' : 'Other simulators'} items={others} selected={selected} />
              </Collapsible>
            ) : null}
            {!android && !hasWorktreeSim && base && s.workspace ? (
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
        <Tab value="devices" label={`📱 Devices · ${connected}/${physical.length}`}>
          {physical.length > 0 ? (
            <DeviceList label="Devices" items={physical} selected={selected} />
          ) : (
            <EmptyState
              icon="globe"
              title="No devices"
              description={
                android
                  ? 'Connect your phone by USB with USB debugging on, or pair it over Wi-Fi (Developer options → Wireless debugging).'
                  : 'Connect your iPhone by cable, or pair it over Wi-Fi in Xcode (Window → Devices and Simulators).'
              }
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
  const android = platformOf(s) === 'android'
  const offered = read(configurations) ?? (android ? ['debug', 'release'] : ['Debug', 'Release'])
  const configurationList = Array.from(new Set([...offered, s.config.configuration]))
  const auto = autoScheme(s)
  const project = s.projects.find((p) => p.path === s.config.project) ?? s.projects[0]!
  return (
    <Collapsible
      title="Build"
      description={`${project.label} · ${s.config.scheme ?? (auto ? `${auto} (auto)` : android ? 'automatic module' : 'automatic scheme')} · ${s.config.configuration}`}
    >
      <Stack gap="sm">
        {s.projects.length > 1 ? (
          <Select
            label="Project"
            value={s.config.project}
            options={s.projects.map((p) => ({ value: p.path, label: `${p.platform === 'ios' ? 'iOS' : 'Android'} · ${p.label}` }))}
            onChange={(value) => updateConfig('project', { project: value })}
          />
        ) : null}
        <Row gap="xs" align="end">
          <Select
            label={android ? 'Module' : 'Scheme'}
            value={s.config.scheme}
            placeholder={schemeList === null ? (android ? 'Reading modules…' : 'Reading schemes…') : 'Automatic'}
            options={schemeOptions}
            disabled={schemeList === null}
            onChange={(scheme) => updateConfig('scheme', { scheme })}
          />
          <IconButton icon="refresh" label={android ? 'Reload modules' : 'Reload schemes'} variant="ghost" onPress={() => loadSchemes(true)} />
        </Row>
        {read(schemesError) ? (
          <Text tone="warning" size="xs">
            {read(schemesError)}
          </Text>
        ) : null}
        <Select
          label={android ? 'Variant' : 'Configuration'}
          value={s.config.configuration}
          options={configurationList.map((c) => ({ value: c, label: c }))}
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
          description={`${s.workspace.name} has no Xcode project or Gradle build at its root or in ios/, android/, app/ or mobile/.`}
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
      {read(pickerOpen) || !s.config.destination ? <Destinations s={s} /> : null}
    </Stack>
  )
}
