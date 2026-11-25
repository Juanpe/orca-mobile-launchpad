// One door to both adapters: the worker asks here and the project's platform picks iOS or Android.
import { readFile } from 'node:fs/promises'
import type { Destination, Device, Platform, ProjectRef, WorkspaceConfig } from '../types'
import { worktreeSimulatorName } from '../types'
import {
  findAndroidProjects,
  listAndroidDevices,
  listAppModules,
  listModules,
  listVariants,
  startAndroidRun
} from './android'
import { preferredAndroidDestination, preferredModule, summarizeAndroidCrash } from './android-parse'
import { findProjects as findIosProjects, listAppSchemes, listDevices as listIosDevices, listSchemes, startRun as startIosRun } from './ios'
import { preferredDestination as preferredIosDestination, preferredScheme, summarizeCrash } from './ios-parse'

/** iOS projects first (Xcode workspace before project), then Gradle builds. */
export async function findProjects(root: string): Promise<ProjectRef[]> {
  const [ios, android] = await Promise.all([findIosProjects(root), findAndroidProjects(root)])
  return [...ios, ...android]
}

/** The platform of a project path, by the project list it came from (`.xc*` means iOS). */
export function platformOf(projectPath: string | undefined, projects: readonly ProjectRef[] = []): Platform {
  const known = projects.find((p) => p.path === projectPath)?.platform
  if (known) return known
  return projectPath && /\.(xcworkspace|xcodeproj)$/.test(projectPath) ? 'ios' : 'android'
}

/** Schemes (iOS) or modules (Android), and those that build an app. */
export async function listTargets(platform: Platform, project: string): Promise<{ schemes: string[]; appSchemes: string[] }> {
  if (platform === 'android') {
    const [schemes, appSchemes] = await Promise.all([listModules(project), listAppModules(project)])
    return { schemes, appSchemes }
  }
  const [schemes, appSchemes] = await Promise.all([listSchemes(project), listAppSchemes(project)])
  return { schemes, appSchemes }
}

export function defaultTarget(platform: Platform, project: string, targets: { schemes: string[]; appSchemes: string[] }): string | undefined {
  return platform === 'android' ? preferredModule(targets.appSchemes) : preferredScheme(targets.schemes, project, targets.appSchemes)
}

/** Configurations (iOS) or build variants (Android) to offer. */
export async function listConfigurations(platform: Platform, project: string, target?: string): Promise<string[]> {
  if (platform === 'android') return target ? listVariants(project, target) : ['debug', 'release']
  return ['Debug', 'Release']
}

export const DEFAULT_CONFIGURATION: Record<Platform, string> = { ios: 'Debug', android: 'debug' }

/** Simulators, emulators and phones of both platforms. */
export async function listDevices(): Promise<{ devices: Device[]; error?: string }> {
  // Tests list made-up devices from a JSON file instead of asking Xcode and adb.
  const fake = process.env.MOBILE_LAUNCHPAD_DEVICES
  if (fake) return { devices: JSON.parse(await readFile(fake, 'utf8')) as Device[] }
  const [ios, android] = await Promise.all([listIosDevices(), listAndroidDevices()])
  const error = [ios.error, android.error].filter(Boolean).join('\n')
  const devices = [...ios.devices, ...android.devices]
  return error ? { devices, error } : { devices }
}

/** A sensible destination for the platform, among its own devices only. */
export function defaultDestination(platform: Platform, devices: readonly Device[], workspaceName: string): Device | undefined {
  if (platform === 'android') return preferredAndroidDestination(devices)
  const ios = devices.filter((d) => d.platform === 'ios')
  return ios.length ? preferredIosDestination(ios, worktreeSimulatorName(workspaceName)) : undefined
}

/** The listed device a destination names, when it can be run on now: a simulator or emulator
 *  that is listed (a shut-down one boots on run), or a phone that is connected. */
export function availableDevice(destination: Destination | undefined, devices: readonly Device[]): Device | undefined {
  if (!destination) return undefined
  const device = devices.find((d) => d.platform === destination.platform && d.udid === destination.udid)
  return device && (device.kind === 'simulator' || device.state === 'connected') ? device : undefined
}

/** Where a worktree runs: its own destination while it is available, else the platform's last
 *  used device (in any worktree) while that is available, else the first sensible one. */
export function chooseDestination(
  platform: Platform,
  devices: readonly Device[],
  workspaceName: string,
  saved: Destination | undefined,
  lastUsed: Destination | undefined
): Device | undefined {
  const own = (d: Destination | undefined) => (d?.platform === platform ? availableDevice(d, devices) : undefined)
  return own(saved) ?? own(lastUsed) ?? defaultDestination(platform, devices.filter((d) => d.kind === 'simulator' || d.state === 'connected'), workspaceName)
}

export type StartRequest = {
  platform: Platform
  config: Required<Pick<WorkspaceConfig, 'project' | 'scheme' | 'configuration' | 'destination'>>
  statusFile: string
  logFile: string
}

/** Starts the platform's runner; answers its process group's pid. */
export function startRun(request: StartRequest, outFile: string): Promise<number> {
  const { config } = request
  if (request.platform === 'android') {
    return startAndroidRun(
      {
        projectPath: config.project,
        module: config.scheme,
        variant: config.configuration,
        destination: config.destination,
        statusFile: request.statusFile,
        logFile: request.logFile,
        openEmulatorPane: true
      },
      outFile
    )
  }
  return startIosRun(
    {
      projectPath: config.project,
      scheme: config.scheme,
      configuration: config.configuration,
      destination: config.destination,
      statusFile: request.statusFile,
      logFile: request.logFile,
      openSimulatorApp: true
    },
    outFile
  )
}

/** A crash report's title and summary: an iOS `.ips`, or Android's crash buffer (`.txt`). */
export function summarizeCrashFile(path: string, text: string): { title: string; summary: string } {
  return path.endsWith('.txt') ? summarizeAndroidCrash(text) : summarizeCrash(text)
}
