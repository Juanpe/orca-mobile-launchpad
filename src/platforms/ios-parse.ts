// Pure parsers for Xcode's JSON outputs, kept apart from the code that runs the tools so tests
// can feed them fixtures.
import type { Device } from '../types'

type SimctlDevice = {
  udid: string
  name: string
  state: string
  isAvailable?: boolean
  deviceTypeIdentifier?: string
}

/** `xcrun simctl list devices available -j` → iOS simulators, booted first, then by name. */
export function parseSimctlDevices(json: string): Device[] {
  const data = JSON.parse(json) as { devices?: Record<string, SimctlDevice[]> }
  const out: Device[] = []
  for (const [runtimeId, devices] of Object.entries(data.devices ?? {})) {
    const match = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtimeId)
    if (!match) continue // watchOS, tvOS, visionOS: not yet
    const os = [match[1], match[2], match[3]].filter(Boolean).join('.')
    for (const d of devices) {
      if (d.isAvailable === false) continue
      out.push({
        platform: 'ios',
        kind: 'simulator',
        udid: d.udid,
        name: d.name,
        state: d.state === 'Booted' ? 'booted' : 'shutdown',
        os,
        ...(d.deviceTypeIdentifier ? { deviceTypeId: d.deviceTypeIdentifier } : {}),
        runtimeId
      })
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.state === 'booted') - Number(a.state === 'booted') ||
      a.name.localeCompare(b.name) ||
      compareVersions(b.os, a.os)
  )
}

type DevicectlDevice = {
  identifier: string
  connectionProperties?: { transportType?: string; tunnelState?: string }
  deviceProperties?: { name?: string; osVersionNumber?: string }
  hardwareProperties?: { udid?: string; reality?: string; platform?: string }
}

/** `xcrun devicectl list devices --json-output <file>` → physical iOS devices, connected first. */
export function parseDevicectlDevices(json: string): Device[] {
  const data = JSON.parse(json) as { result?: { devices?: DevicectlDevice[] } }
  const out: Device[] = []
  for (const d of data.result?.devices ?? []) {
    const hw = d.hardwareProperties ?? {}
    if (hw.reality !== 'physical' || hw.platform !== 'iOS') continue
    const conn = d.connectionProperties ?? {}
    const transport =
      conn.transportType === 'wired'
        ? 'cable'
        : conn.transportType === 'localNetwork'
          ? 'wifi'
          : undefined
    const connected = conn.tunnelState === 'connected' || transport !== undefined
    out.push({
      platform: 'ios',
      kind: 'device',
      // xcodebuild's `-destination id=` wants the hardware UDID; devicectl accepts it too.
      udid: hw.udid ?? d.identifier,
      name: d.deviceProperties?.name ?? 'iPhone',
      state: connected ? 'connected' : 'unavailable',
      ...(transport ? { transport } : {}),
      os: d.deviceProperties?.osVersionNumber ?? ''
    })
  }
  return out.sort(
    (a, b) =>
      Number(b.state === 'connected') - Number(a.state === 'connected') ||
      a.name.localeCompare(b.name)
  )
}

/** `xcodebuild -list -json` → scheme names. */
export function parseSchemes(json: string): string[] {
  // xcodebuild can print warnings before the JSON object.
  const start = json.indexOf('{')
  if (start < 0) return []
  const data = JSON.parse(json.slice(start)) as {
    workspace?: { schemes?: string[] }
    project?: { schemes?: string[] }
  }
  return data.workspace?.schemes ?? data.project?.schemes ?? []
}

/** Picks the scheme a person most likely means: the one named like the project, else the first
 *  that does not look like a test or package scheme. */
export function preferredScheme(schemes: readonly string[], projectPath: string): string | undefined {
  const base = projectPath.split('/').pop()?.replace(/\.(xcworkspace|xcodeproj)$/, '')
  if (base && schemes.includes(base)) return base
  return schemes.find((s) => !/(tests?|package|-Package)$/i.test(s)) ?? schemes[0]
}

/** Picks a default destination: a booted simulator named for the worktree, any booted iPhone,
 *  the newest iPhone simulator, then anything. */
export function preferredDestination(devices: readonly Device[], simulatorName: string): Device | undefined {
  const sims = devices.filter((d) => d.kind === 'simulator')
  return (
    sims.find((d) => d.name === simulatorName) ??
    sims.find((d) => d.state === 'booted' && /iPhone/.test(d.name)) ??
    sims.find((d) => d.state === 'booted') ??
    [...sims]
      .filter((d) => /iPhone/.test(d.name))
      .sort((a, b) => compareVersions(b.os, a.os))[0] ??
    sims[0] ??
    devices[0]
  )
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}
