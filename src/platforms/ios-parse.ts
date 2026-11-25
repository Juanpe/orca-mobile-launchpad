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

/** Picks the scheme a person most likely means: an app scheme (named like the project first),
 *  else the one named like the project, else the first that is not a test or package scheme. */
export function preferredScheme(
  schemes: readonly string[],
  projectPath: string,
  appSchemes: readonly string[] = []
): string | undefined {
  const base = projectPath.split('/').pop()?.replace(/\.(xcworkspace|xcodeproj)$/, '')
  const apps = appSchemes.filter((a) => schemes.length === 0 || schemes.includes(a))
  if (apps.length) return (base && apps.find((a) => a === base)) ?? apps[0]
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

/** True when an `.xcscheme` builds an app (`BuildableName = "X.app"`). */
export function schemeBuildsApp(xml: string): boolean {
  return /BuildableName\s*=\s*"[^"]+\.app"/.test(xml)
}

/** The lines worth showing from a failed `xcodebuild` or Gradle log: compiler and linker errors first,
 *  then the build's own summary, without duplicates. */
export function extractBuildErrors(log: string, max = 12): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of log.split('\n')) {
    const line = raw.trim()
    if (
      // xcodebuild, then Gradle: Kotlin's `e: file:///…`, javac/aapt `ERROR:`, Gradle's summary.
      !/(\berror:|❌|fatal error|\*\* BUILD FAILED \*\*|Command \w+ failed|xcodebuild: error|✗ |^e: |^ERROR:|FAILURE: Build failed|^> Task \S+ FAILED|^> (?!Task |Configure ))/.test(line) ||
      /^\s*$/.test(line)
    ) {
      continue
    }
    // Make absolute paths short: keep the file name and position.
    const short = line.replace(/file:\/\//g, '').replace(/\/(?:[^/\s:]+\/)+([^/\s:]+:\d+(?::\d+)?)/g, '$1')
    if (seen.has(short)) continue
    seen.add(short)
    out.push(short.length > 300 ? `${short.slice(0, 300)}…` : short)
    if (out.length >= max) break
  }
  return out
}

/** The end of a log, at most `maxChars` characters, starting on a whole line. */
export function logTail(log: string, maxLines = 160, maxChars = 12_000): string {
  let tail = log.split('\n').slice(-maxLines).join('\n')
  if (tail.length > maxChars) {
    tail = tail.slice(-maxChars)
    tail = tail.slice(tail.indexOf('\n') + 1)
  }
  return tail.trimEnd()
}

type IpsFrame = { symbol?: string; imageIndex?: number; imageOffset?: number }
type IpsBody = {
  exception?: { type?: string; signal?: string; codes?: string; subtype?: string }
  termination?: { indicator?: string; namespace?: string }
  asi?: Record<string, string[]>
  faultingThread?: number
  threads?: { frames?: IpsFrame[]; queue?: string; name?: string }[]
  usedImages?: { name?: string }[]
  procName?: string
}

/** A short, readable summary of an `.ips` crash report: what killed the app and the top frames
 *  of the thread that crashed. */
export function summarizeCrash(ips: string, maxFrames = 14): { title: string; summary: string } {
  const newline = ips.indexOf('\n')
  const header = JSON.parse(ips.slice(0, newline)) as { app_name?: string; name?: string; timestamp?: string }
  const body = JSON.parse(ips.slice(newline + 1)) as IpsBody
  const ex = body.exception ?? {}
  const title = [ex.type, ex.signal && `(${ex.signal})`].filter(Boolean).join(' ') || 'Crash'
  const lines: string[] = [`${header.app_name ?? body.procName ?? 'App'} — ${title}`]
  if (ex.subtype) lines.push(ex.subtype)
  if (body.termination?.indicator) lines.push(`Termination: ${body.termination.indicator}`)
  for (const messages of Object.values(body.asi ?? {})) {
    for (const message of messages) lines.push(message)
  }
  const thread = body.threads?.[body.faultingThread ?? 0]
  if (thread) {
    lines.push('', `Thread ${body.faultingThread ?? 0} crashed${thread.queue ? ` (${thread.queue})` : ''}:`)
    for (const [i, frame] of (thread.frames ?? []).slice(0, maxFrames).entries()) {
      const image = body.usedImages?.[frame.imageIndex ?? -1]?.name ?? '???'
      lines.push(`${String(i).padEnd(3)} ${image.padEnd(24)} ${frame.symbol ?? `+${frame.imageOffset ?? 0}`}`)
    }
  }
  return { title, summary: lines.join('\n') }
}
