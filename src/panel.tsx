// Mobile Launchpad's sidebar panel. A "launch card" says what runs where and how far the build
// got; below it, the destination picker and the build settings. The worker owns all state.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
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
  type PanelContext
} from 'orca'
import './protocol'
import {
  isActive,
  worktreeSimulatorName,
  type Device,
  type LaunchpadState,
  type RunPhase,
  type WorkspaceConfig
} from './types'

const state = atom<LaunchpadState | null>(null)
const schemes = atom<string[] | null>(null)
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
  const answer = await plugin.request('schemes.list', { refresh }, { timeoutMs: 120_000 })
  set(schemes, answer.schemes)
  set(schemesError, answer.error)
}

async function loadDevices(): Promise<void> {
  set(devices, null)
  const answer = await plugin.request('devices.list', undefined, { timeoutMs: 60_000 })
  set(devices, answer.devices)
  set(devicesError, answer.error)
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

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', receive))
  void plugin.request('state.get').then(receive, (e: Error) => set(error, e.message))
  void loadDevices()
}

// ── Run status ────────────────────────────────────────────────────────────────────────────────

type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning'

const PHASE: Record<RunPhase, { label: string; tone: Tone; progress?: number }> = {
  idle: { label: 'Ready', tone: 'neutral' },
  preparing: { label: 'Preparing', tone: 'accent', progress: 10 },
  building: { label: 'Building', tone: 'accent', progress: 40 },
  installing: { label: 'Installing', tone: 'accent', progress: 75 },
  launching: { label: 'Launching', tone: 'accent', progress: 90 },
  running: { label: 'Running', tone: 'success' },
  exited: { label: 'Exited', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' }
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
  const where = destination
    ? `${destination.name}${device?.kind === 'device' ? ` · ${transportLabel(device)}` : ''}`
    : 'automatic destination'
  const project = s.projects.find((p) => p.path === s.config.project) ?? s.projects[0]
  const projectName = project?.label.split('/').pop()?.replace(/\.(xcworkspace|xcodeproj)$/, '')
  const title = s.config.scheme ?? projectName ?? 'App'
  const branch = s.workspace?.branch ?? ''
  const subtitle = !branch
    ? s.workspace?.name ?? ''
    : branch.includes(s.workspace?.name ?? '\u0000')
      ? branch
      : `${s.workspace?.name} · ${branch}`
  const disabled = read(busy) !== null
  return (
    <Box border={live ? phase.tone : true} radius="lg" padding="md" background="card" gap="sm">
      <Row justify="between" align="start">
        <Stack gap="none">
          <Text muted size="xs" weight="medium" truncate>
            {subtitle}
          </Text>
          <Heading level={1}>{title}</Heading>
          <Row gap="xs" align="center">
            {destination ? (
              <Badge tone={destination.kind === 'device' ? 'accent' : 'neutral'}>
                {destination.kind === 'device' ? 'iPhone' : 'Simulator'}
              </Badge>
            ) : null}
            <Text size="sm" truncate>
              {`→ ${where}`}
            </Text>
          </Row>
        </Stack>
        <Badge tone={phase.tone}>{phase.label}</Badge>
      </Row>

      {active ? (
        <Stack gap="xs">
          <Row gap="xs" align="center">
            <Spinner label={phase.label} labelHidden />
            <Text size="sm">{`${phase.label}…`}</Text>
            {run.startedAt ? <RelativeTime at={run.startedAt} format="duration" muted /> : null}
          </Row>
          <Progress label={phase.label} labelHidden value={phase.progress} />
        </Stack>
      ) : run.phase === 'running' && run.startedAt ? (
        <Text size="sm" tone="success">
          {`Running on ${run.destinationName} · `}
          <RelativeTime at={run.startedAt} format="short" />
        </Text>
      ) : null}

      <Row gap="xs">
        <Button
          icon={live ? 'refresh' : 'play'}
          variant="solid"
          tone="accent"
          disabled={disabled}
          tooltip={destination ? 'Mod+Alt+R' : 'No destination chosen: uses the worktree simulator or a booted one (Mod+Alt+R)'}
          onPress={() => guarded('run', async () => receive(await plugin.request('run', undefined, { timeoutMs: 120_000 })))}
        >
          {live ? 'Relaunch' : 'Build & Run'}
        </Button>
        {live ? (
          <Button icon="stop" variant="outline" tone="danger" disabled={disabled} onPress={() => guarded('stop', async () => receive(await plugin.request('stop')))}>
            Stop
          </Button>
        ) : null}
      </Row>
    </Box>
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
  const schemeOptions = (schemeList ?? (s.config.scheme ? [s.config.scheme] : [])).map((x) => ({ value: x, label: x }))
  const configurations = Array.from(new Set(['Debug', 'Release', s.config.configuration]))
  const project = s.projects.find((p) => p.path === s.config.project) ?? s.projects[0]!
  return (
    <Collapsible
      title="Build"
      description={`${project.label} · ${s.config.scheme ?? 'automatic scheme'} · ${s.config.configuration}`}
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
    return <EmptyState icon="rocket" title="No active worktree" description="Open a worktree with a mobile app." />
  }
  if (s.projects.length === 0) {
    return (
      <EmptyState
        icon="rocket"
        title="No mobile app here"
        description={`${s.workspace.name} has no iOS project at its root or in ios/, app/ or mobile/ios.`}
      />
    )
  }
  return (
    <Stack gap="md">
      <LaunchCard s={s} />
      {s.run.phase === 'failed' ? (
        <Callout tone="danger" title="Build failed" icon="error">
          <Text size="sm">{s.run.message ?? 'Check the build terminal.'}</Text>
        </Callout>
      ) : null}
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
