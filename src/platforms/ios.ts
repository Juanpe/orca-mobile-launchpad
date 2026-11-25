// The iOS adapter: finding Xcode projects, listing destinations, and the script a run executes.
// An Android adapter would offer the same functions over Gradle and adb.
import { mkdir, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { exec, shellQuote } from '../exec'
import type { Destination, Device, ProjectRef } from '../types'
import { parseDevicectlDevices, parseSchemes, parseSimctlDevices } from './ios-parse'

/** Where a repository keeps its iOS app: the root, or a conventional mobile folder. Only these
 *  are searched, so a folder that merely contains other repositories (say "Side Projects") does
 *  not count as an iOS project. */
// Case matters on case-sensitive volumes only; findProjects drops the duplicates elsewhere.
const IOS_DIRS = [
  '',
  'ios',
  'iOS',
  'iosApp',
  'iOSApp',
  'apple',
  'app',
  'App',
  'mobile/ios',
  'apps/ios',
  'app/ios',
  'client/ios'
]

/** Xcode workspaces and projects in the worktree root or a conventional iOS folder. A workspace
 *  beside a project (CocoaPods, Tuist) comes first, since that is the one to build. */
export async function findProjects(root: string): Promise<ProjectRef[]> {
  const found: ProjectRef[] = []
  const seen = new Set<string>()
  for (const sub of IOS_DIRS) {
    const dir = sub ? join(root, sub) : root
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = entry.name
      if (!entry.isDirectory() || !(name.endsWith('.xcworkspace') || name.endsWith('.xcodeproj'))) continue
      const path = join(dir, name)
      if (seen.has(path.toLowerCase())) continue // ios/ and iOS/ on a case-insensitive disk
      seen.add(path.toLowerCase())
      found.push({
        platform: 'ios',
        kind: name.endsWith('.xcworkspace') ? 'workspace' : 'project',
        path,
        label: relative(root, path)
      })
    }
  }
  const depthOf = (p: ProjectRef) => p.label.split('/').length
  return found.sort(
    (a, b) =>
      depthOf(a) - depthOf(b) ||
      Number(b.kind === 'workspace') - Number(a.kind === 'workspace') ||
      a.label.localeCompare(b.label)
  )
}

export function containerFlag(projectPath: string): '-workspace' | '-project' {
  return projectPath.endsWith('.xcworkspace') ? '-workspace' : '-project'
}

export async function listSchemes(projectPath: string): Promise<string[]> {
  const { stdout } = await exec(
    'xcrun',
    ['xcodebuild', '-list', '-json', containerFlag(projectPath), projectPath],
    { timeoutMs: 90_000 }
  )
  return parseSchemes(stdout)
}

export async function listDevices(): Promise<{ devices: Device[]; error?: string }> {
  const errors: string[] = []
  const simulators = exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    timeoutMs: 30_000
  })
    .then((r) => parseSimctlDevices(r.stdout))
    .catch((e: Error) => {
      errors.push(e.message)
      return [] as Device[]
    })
  const physical = (async () => {
    const dir = await workDir()
    const file = join(dir, `devicectl-${process.pid}.json`)
    try {
      await exec('xcrun', ['devicectl', 'list', 'devices', '--json-output', file, '-q'], {
        timeoutMs: 30_000
      })
      return parseDevicectlDevices(await readFile(file, 'utf8'))
    } catch (e) {
      errors.push((e as Error).message)
      return [] as Device[]
    } finally {
      await rm(file, { force: true })
    }
  })()
  const [sims, devices] = await Promise.all([simulators, physical])
  const all = [...devices, ...sims]
  // Plain JSON for the panel bridge: no `undefined` values.
  return errors.length ? { devices: all, error: errors.join('\n') } : { devices: all }
}

/** Creates a simulator with `base`'s model and OS; answers its UDID. */
export async function createSimulator(name: string, base: Device): Promise<string> {
  if (!base.deviceTypeId || !base.runtimeId) throw new Error(`${base.name} is not a simulator`)
  const { stdout } = await exec('xcrun', ['simctl', 'create', name, base.deviceTypeId, base.runtimeId])
  return stdout.trim()
}

/** Where Launchpad keeps its runner script and status files. */
export async function workDir(): Promise<string> {
  const dir = join(tmpdir(), 'orca-launchpad')
  await mkdir(dir, { recursive: true })
  return dir
}

export type RunRequest = {
  projectPath: string
  scheme: string
  configuration: string
  destination: Destination
  statusFile: string
  openSimulatorApp: boolean
}

/** Writes the runner script and answers the shell command that runs it in an Orca terminal. */
export async function prepareRunCommand(request: RunRequest): Promise<string> {
  const script = join(await workDir(), 'ios-run.sh')
  await writeFile(script, RUN_SCRIPT, 'utf8')
  await chmod(script, 0o755)
  const args = [
    request.statusFile,
    request.destination.kind,
    request.destination.udid,
    containerFlag(request.projectPath),
    request.projectPath,
    request.scheme,
    request.configuration,
    request.openSimulatorApp ? '1' : '0'
  ]
  return ['/bin/bash', script, ...args].map(shellQuote).join(' ')
}

/**
 * The runner. It writes its phase to the status file (one word, or `failed:<reason>`), which the
 * worker polls to drive the status bar, and prints the build and the app's console to the
 * terminal. Ctrl-C in the terminal stops the app and marks the run `stopped`.
 */
export const RUN_SCRIPT = String.raw`#!/bin/bash
# Mobile Launchpad iOS runner. Written by the Mobile Launchpad Orca plugin; rewritten on every run.
set -o pipefail
STATUS="$1"; KIND="$2"; UDID="$3"; CONTAINER_FLAG="$4"; CONTAINER="$5"
SCHEME="$6"; CONFIG="$7"; OPEN_SIM="$8"

status() { printf '%s\n' "$*" > "$STATUS"; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { status "failed:$*"; printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }
trap 'status stopped; printf "\n\033[33m■ Stopped\033[0m\n"; exit 130' INT TERM

SIGNING=""
[ "$KIND" = device ] && SIGNING="-allowProvisioningUpdates"
# $SIGNING is unquoted on purpose: empty for simulators, one flag for devices.
xcb() { xcrun xcodebuild "$CONTAINER_FLAG" "$CONTAINER" -scheme "$SCHEME" -configuration "$CONFIG" -destination "id=$UDID" $SIGNING "$@"; }

if [ "$KIND" = simulator ]; then
  status preparing
  step "Booting simulator"
  xcrun simctl bootstatus "$UDID" -b > /dev/null || fail "Could not boot the simulator"
  if [ "$OPEN_SIM" = 1 ]; then
    # Orca's emulator pane when this runs in an Orca terminal; else Simulator.app if installed.
    if command -v orca > /dev/null && orca emulator attach "$UDID" --json > /dev/null 2>&1; then
      printf "  Simulator shown in Orca's emulator pane\n"
    else
      open -g -b com.apple.iphonesimulator --args -CurrentDeviceUDID "$UDID" 2> /dev/null || true
    fi
  fi
fi

status building
step "Building $SCHEME ($CONFIG)"
# A version-manager shim (mise, asdf) can exist without a working xcbeautify: run it to be sure.
if xcbeautify --version > /dev/null 2>&1; then
  xcb build 2>&1 | xcbeautify --disable-logging || fail "Build failed"
else
  xcb -quiet build || fail "Build failed"
fi

PRODUCTS=$(xcb -showBuildSettings 2> /dev/null | awk -F ' = ' '/^ *TARGET_BUILD_DIR = /{print $2; exit}')
[ -d "$PRODUCTS" ] || fail "Build products folder not found"
APP="$PRODUCTS/$SCHEME.app"
[ -d "$APP" ] || APP=$(ls -td "$PRODUCTS"/*.app 2> /dev/null | head -1)
[ -d "$APP" ] || fail "No .app found in $PRODUCTS"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2> /dev/null)
[ -n "$BUNDLE_ID" ] || fail "Could not read the bundle id of $APP"

status installing
step "Installing $(basename "$APP") ($BUNDLE_ID)"
if [ "$KIND" = simulator ]; then
  xcrun simctl install "$UDID" "$APP" || fail "Could not install on the simulator"
  status launching
  step "Launching (Ctrl-C to stop)"
  status running
  xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE_ID" || fail "Could not launch the app"
else
  xcrun devicectl device install app --device "$UDID" "$APP" || fail "Could not install on the device"
  status launching
  step "Launching (Ctrl-C to stop)"
  status running
  xcrun devicectl device process launch --device "$UDID" --terminate-existing --console "$BUNDLE_ID" || fail "Could not launch the app (is the iPhone locked?)"
fi
status exited
printf '\n\033[2m● The app exited\033[0m\n'
`
