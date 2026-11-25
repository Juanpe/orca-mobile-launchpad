// Pure parsers for the Android adapter: adb's device list, Gradle's settings and build files, and
// logcat's crash buffer. Kept apart from android.ts so tests need no SDK.
import type { Device } from '../types'

/** `adb devices -l`: emulators (serial `emulator-NNNN`) and phones, by USB or Wi-Fi. */
export function parseAdbDevices(text: string): { serial: string; state: string; model?: string }[] {
  const out: { serial: string; state: string; model?: string }[] = []
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(device|offline|unauthorized|no permissions|authorizing|connecting)\b(.*)$/.exec(line.trim())
    if (!match) continue
    const model = /\bmodel:(\S+)/.exec(match[3] ?? '')?.[1]
    out.push(model ? { serial: match[1]!, state: match[2]!, model: model.replace(/_/g, ' ') } : { serial: match[1]!, state: match[2]! })
  }
  return out
}

/** A phone on Wi-Fi shows as `ip:port` or an mDNS `adb-…._adb-tls-connect._tcp` serial. */
export function adbTransport(serial: string): 'wifi' | 'cable' {
  return /:\d+$|_adb-tls-connect|\._tcp/.test(serial) ? 'wifi' : 'cable'
}

/** An AVD's API level from its config.ini (`image.sysdir.1=system-images/android-36/…`). */
export function avdApiLevel(configIni: string): string | undefined {
  return /system-images\/android-([\w.-]+)\//.exec(configIni)?.[1]
}

/** Module paths `include`d by settings.gradle(.kts): `include(":app", ":core")`, `include ':app'`. */
export function parseIncludedModules(settings: string): string[] {
  const modules = new Set<string>()
  for (const statement of settings.match(/^\s*include\b[^\n]*/gm) ?? []) {
    for (const m of statement.matchAll(/["']([:\w.-]+)["']/g)) {
      const path = m[1]!.startsWith(':') ? m[1]! : `:${m[1]}`
      modules.add(path)
    }
  }
  return [...modules]
}

/** True when a module's build file applies the Android application plugin. */
export function isAppModule(buildFile: string): boolean {
  return /com\.android\.application|\bandroid\.application\b|libs\.plugins\.android\.application/.test(buildFile)
}

/** The text between the braces of the first `name {` block, or '' without one. */
function block(source: string, name: string): string {
  const start = new RegExp(`\\b${name}\\s*\\{`).exec(source)
  if (!start) return ''
  let depth = 0
  for (let i = start.index + start[0].length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start.index + start[0].length, i)
  }
  return ''
}

/** Names declared in a block with `create("x")`, `register("x")`, `getByName("x")` or Groovy `x {`. */
function declaredNames(body: string): string[] {
  const names = new Set<string>()
  for (const m of body.matchAll(/\b(?:create|register|getByName|maybeCreate)\s*\(\s*["'](\w+)["']/g)) names.add(m[1]!)
  // Groovy DSL: `staging {` at the block's top level.
  let depth = 0
  for (const line of body.split('\n')) {
    const groovy = /^\s*(\w+)\s*\{/.exec(line)
    if (depth === 0 && groovy && !['getByName', 'create', 'register', 'named', 'all', 'configureEach'].includes(groovy[1]!)) names.add(groovy[1]!)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
  }
  return [...names]
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The app module's build variants: each flavor with each build type (`freeDebug`), or the build
 *  types alone (`debug`, `release`, plus any the file declares). */
export function parseVariants(buildFile: string): string[] {
  const types = ['debug', 'release']
  for (const name of declaredNames(block(buildFile, 'buildTypes'))) if (!types.includes(name)) types.push(name)
  const flavors = declaredNames(block(buildFile, 'productFlavors'))
  if (!flavors.length) return types
  return flavors.flatMap((flavor) => types.map((type) => `${flavor}${capitalize(type)}`))
}

/** Gradle's task suffix for a variant: `freeDebug` → `FreeDebug`. */
export function variantTask(variant: string): string {
  return capitalize(variant)
}

/** Picks the module to run: `:app` when it is an app module, else the first app module. */
export function preferredModule(appModules: readonly string[]): string | undefined {
  return appModules.find((m) => m === ':app') ?? appModules[0]
}

/** Default destination on Android: a running emulator, a connected phone, then any emulator. */
export function preferredAndroidDestination(devices: readonly Device[]): Device | undefined {
  const android = devices.filter((d) => d.platform === 'android')
  return (
    android.find((d) => d.kind === 'simulator' && d.state === 'booted') ??
    android.find((d) => d.kind === 'device' && d.state === 'connected') ??
    android.find((d) => d.kind === 'simulator')
  )
}

/** The crash report logcat's crash buffer keeps: `FATAL EXCEPTION: main / Process: pkg / java.lang.X: msg`. */
export function summarizeAndroidCrash(text: string, maxLines = 40): { title: string; summary: string } {
  const lines = text.split('\n').map((l) => l.replace(/^.*?\bE AndroidRuntime:\s?/, '').replace(/\r$/, ''))
  const start = lines.findIndex((l) => /FATAL EXCEPTION/.test(l))
  const body = (start >= 0 ? lines.slice(start) : lines).filter((l) => l.trim() !== '')
  const exception = body.find((l) => /^[\w.$]+(Exception|Error|Throwable)\b/.test(l.trim()))?.trim()
  return {
    title: exception ? (exception.length > 160 ? `${exception.slice(0, 160)}…` : exception) : 'The app crashed',
    summary: body.slice(0, maxLines).join('\n')
  }
}
