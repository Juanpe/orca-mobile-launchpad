// Launchpad's sidebar panel: pick project, scheme, configuration and destination for the focused
// worktree, and run it. The worker owns all state; the panel draws what it posts.
import {
  atom,
  Badge,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import './protocol'
import {
  isActive,
  worktreeSimulatorName,
  type Device,
  type LaunchpadState,
  type RunPhase
} from './types'

const state = atom<LaunchpadState | null>(null)
const schemes = atom<string[] | null>(null)
const schemesError = atom<string | undefined>(undefined)
const devices = atom<Device[] | null>(null)
const devicesError = atom<string | undefined>(undefined)
const busy = atom<string | null>(null)
const error = atom<string | null>(null)

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

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'Listo',
  preparing: 'Preparando',
  building: 'Compilando',
  installing: 'Instalando',
  launching: 'Lanzando',
  running: 'Ejecutándose',
  exited: 'Terminó',
  stopped: 'Detenido',
  failed: 'Falló'
}

function phaseTone(phase: RunPhase): 'neutral' | 'accent' | 'success' | 'danger' | 'warning' {
  if (isActive(phase)) return 'accent'
  if (phase === 'running') return 'success'
  if (phase === 'failed') return 'danger'
  return 'neutral'
}

function deviceDescription(d: Device): string {
  if (d.kind === 'device') {
    if (d.state !== 'connected') return `iOS ${d.os} · no disponible`
    return `iOS ${d.os} · ${d.transport === 'cable' ? 'Cable' : 'Wi-Fi'}`
  }
  return `iOS ${d.os}${d.state === 'booted' ? ' · arrancado' : ''}`
}

function DeviceItem({ device, selected }: { device: Device; selected: boolean }) {
  return (
    <ListItem
      title={device.name}
      description={deviceDescription(device)}
      icon={device.kind === 'device' ? (device.transport === 'cable' ? 'plug' : 'globe') : 'layers'}
      current={selected}
      disabled={device.state === 'unavailable'}
      onPress={() =>
        guarded('destino', () =>
          plugin.request('config.update', {
            destination: {
              platform: device.platform,
              kind: device.kind,
              udid: device.udid,
              name: device.name
            }
          })
        )
      }
    />
  )
}

function Destinations({ s }: { s: LaunchpadState }) {
  const list = read(devices)
  const listError = read(devicesError)
  const selected = s.config.destination?.udid
  const header = (
    <Row justify="between">
      <Heading level={3}>Destino</Heading>
      <IconButton icon="refresh" label="Recargar dispositivos" onPress={() => loadDevices()} />
    </Row>
  )
  if (list === null) {
    return (
      <Stack gap="sm">
        {header}
        <Skeleton lines={4} label="Buscando dispositivos" />
      </Stack>
    )
  }
  const physical = list.filter((d) => d.kind === 'device')
  const sims = list.filter((d) => d.kind === 'simulator')
  const worktreeSim = s.workspace ? worktreeSimulatorName(s.workspace.name) : ''
  const hasWorktreeSim = sims.some((d) => d.name === worktreeSim)
  const base =
    sims.find((d) => d.udid === selected) ?? sims.find((d) => /iPhone/.test(d.name)) ?? sims[0]
  return (
    <Stack gap="sm">
      {header}
      {listError ? (
        <Text tone="warning" size="xs">
          {listError}
        </Text>
      ) : null}
      {physical.length > 0 ? (
        <List label="Dispositivos">
          {physical.map((d) => (
            <DeviceItem device={d} selected={d.udid === selected} />
          ))}
        </List>
      ) : null}
      <List label="Simuladores">
        {sims.map((d) => (
          <DeviceItem device={d} selected={d.udid === selected} />
        ))}
      </List>
      {!hasWorktreeSim && base && s.workspace ? (
        <Button
          variant="outline"
          icon="add"
          tooltip={`Crea un ${base.name} con iOS ${base.os} solo para este worktree`}
          disabled={read(busy) !== null}
          onPress={() =>
            guarded('simulador', async () => {
              await plugin.request('simulator.createForWorktree', { baseUdid: base.udid })
              await loadDevices()
            })
          }
        >
          {`Crear simulador «${worktreeSim}»`}
        </Button>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const s = read(state)
  const failure = read(error)
  if (!s) return <Skeleton lines={6} label="Cargando" />
  if (!s.workspace) {
    return <EmptyState icon="rocket" title="Sin worktree activo" description="Abre un worktree con un proyecto de Xcode." />
  }
  if (s.projects.length === 0) {
    return (
      <EmptyState
        icon="rocket"
        title="No hay proyecto de Xcode"
        description={`No encuentro ningún .xcworkspace ni .xcodeproj en ${s.workspace.name}.`}
      />
    )
  }
  const run = s.run
  const schemeList = read(schemes)
  const schemeOptions = (schemeList ?? (s.config.scheme ? [s.config.scheme] : [])).map((x) => ({ value: x, label: x }))
  const configurations = Array.from(new Set(['Debug', 'Release', s.config.configuration]))
  const active = isActive(run.phase) || run.phase === 'running'
  return (
    <Stack gap="md">
      <Row justify="between">
        <Stack gap="none">
          <Heading>{s.workspace.name}</Heading>
          {s.workspace.branch ? (
            <Text muted size="xs" truncate>
              {s.workspace.branch}
            </Text>
          ) : null}
        </Stack>
        <Badge tone={phaseTone(run.phase)}>{PHASE_LABEL[run.phase]}</Badge>
      </Row>

      <Row gap="xs">
        <Button
          icon="play"
          tone="accent"
          disabled={read(busy) !== null}
          tooltip="Mod+Alt+R"
          onPress={() => guarded('run', () => plugin.request('run', undefined, { timeoutMs: 120_000 }))}
        >
          {active ? 'Relanzar' : 'Build & Run'}
        </Button>
        <Button
          icon="stop"
          variant="outline"
          disabled={!active || read(busy) !== null}
          onPress={() => guarded('stop', () => plugin.request('stop'))}
        >
          Stop
        </Button>
      </Row>

      {run.phase === 'failed' ? (
        <Callout tone="danger" title="Falló" icon="error">
          <Text size="sm">{run.message ?? 'Revisa la terminal del build.'}</Text>
        </Callout>
      ) : null}
      {failure ? (
        <Callout tone="danger" title="Error" icon="error">
          <Text size="sm">{failure}</Text>
        </Callout>
      ) : null}
      {run.destinationName && run.phase !== 'idle' ? (
        <Text muted size="xs">
          {`${run.scheme} → ${run.destinationName}`}
        </Text>
      ) : null}

      <Separator />

      {s.projects.length > 1 ? (
        <Select
          label="Proyecto"
          value={s.config.project}
          options={s.projects.map((p) => ({ value: p.path, label: p.label }))}
          onChange={(project) => guarded('proyecto', () => plugin.request('config.update', { project }))}
        />
      ) : (
        <Text size="sm">
          <Text muted size="sm">Proyecto </Text>
          {s.projects[0]!.label}
        </Text>
      )}

      <Row gap="xs" align="end">
        <Select
          label="Scheme"
          value={s.config.scheme}
          placeholder={schemeList === null ? 'Leyendo schemes…' : 'Automático'}
          options={schemeOptions}
          disabled={schemeList === null}
          onChange={(scheme) => guarded('scheme', () => plugin.request('config.update', { scheme }))}
        />
        <IconButton icon="refresh" label="Recargar schemes" onPress={() => loadSchemes(true)} />
      </Row>
      {read(schemesError) ? (
        <Text tone="warning" size="xs">
          {read(schemesError)}
        </Text>
      ) : null}

      <Select
        label="Configuración"
        value={s.config.configuration}
        options={configurations.map((c) => ({ value: c, label: c }))}
        onChange={(configuration) => guarded('configuración', () => plugin.request('config.update', { configuration }))}
      />

      <Separator />
      <Destinations s={s} />
    </Stack>
  )
}
