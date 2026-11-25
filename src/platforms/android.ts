// The Android adapter: finding Gradle builds, their app modules and variants, listing emulators
// and phones through adb, and the script a run executes. Mirrors ios.ts.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { exec } from '../exec'
import type { Destination, Device, ProjectRef } from '../types'
import {
  adbTransport,
  avdApiLevel,
  isAppModule,
  parseAdbDevices,
  parseIncludedModules,
  parseVariants
} from './android-parse'
import { spawnRunner, writeScript } from './runner'

/** Where a repository keeps its Android app: the root, or a conventional mobile folder. */
const ANDROID_DIRS = ['', 'android', 'Android', 'androidApp', 'mobile/android', 'apps/android', 'client/android']

const SETTINGS_FILES = ['settings.gradle.kts', 'settings.gradle']
const BUILD_FILES = ['build.gradle.kts', 'build.gradle']

async function firstFile(dir: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => undefined)
    if (text !== undefined) return text
  }
  return undefined
}

/** A module's folder: `:feature:menu` → `feature/menu`. */
export function moduleDir(project: string, module: string): string {
  return join(project, ...module.split(':').filter(Boolean))
}

/** Gradle builds (a settings file plus at least one app module) at the root or in a mobile folder. */
export async function findAndroidProjects(root: string): Promise<ProjectRef[]> {
  const found: ProjectRef[] = []
  const seen = new Set<string>()
  for (const sub of ANDROID_DIRS) {
    const dir = sub ? join(root, sub) : root
    if (seen.has(dir.toLowerCase())) continue
    const settings = await firstFile(dir, SETTINGS_FILES)
    if (settings === undefined) continue
    if (!(await listAppModules(dir)).length) continue
    seen.add(dir.toLowerCase())
    const name = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings)?.[1]
    const label = relative(root, dir) || '.'
    found.push(name ? { platform: 'android', kind: 'gradle', path: dir, label, name } : { platform: 'android', kind: 'gradle', path: dir, label })
  }
  return found
}

/** Every module the build includes. */
export async function listModules(project: string): Promise<string[]> {
  return parseIncludedModules((await firstFile(project, SETTINGS_FILES)) ?? '')
}

/** Modules that build an app (apply com.android.application). */
export async function listAppModules(project: string): Promise<string[]> {
  const apps: string[] = []
  for (const module of await listModules(project)) {
    const build = await firstFile(moduleDir(project, module), BUILD_FILES)
    if (build && isAppModule(build)) apps.push(module)
  }
  return apps
}

/** The module's build variants (`debug`, `release`, flavors × build types). */
export async function listVariants(project: string, module: string): Promise<string[]> {
  const build = await firstFile(moduleDir(project, module), BUILD_FILES)
  return build ? parseVariants(build) : ['debug', 'release']
}

/** The Android SDK: ANDROID_HOME, ANDROID_SDK_ROOT, or Android Studio's default folder. */
export function sdkDir(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk')
}

/** A JDK for Gradle when JAVA_HOME is unset: the one Android Studio ships. */
export function javaHome(): string {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME
  const studio = '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
  return existsSync(studio) ? studio : ''
}

const adbPath = () => join(sdkDir(), 'platform-tools/adb')

async function adb(args: string[], timeoutMs = 10_000): Promise<string> {
  return (await exec(adbPath(), args, { timeoutMs })).stdout
}

/** Emulators (running or not) and phones, with what the destination picker shows. */
export async function listAndroidDevices(): Promise<{ devices: Device[]; error?: string }> {
  if (!existsSync(adbPath())) return { devices: [] } // no SDK: no Android destinations, no error
  const devices: Device[] = []
  const running = new Set<string>()
  try {
    for (const entry of parseAdbDevices(await adb(['devices', '-l']))) {
      const ok = entry.state === 'device'
      const os = ok ? (await adb(['-s', entry.serial, 'shell', 'getprop', 'ro.build.version.release']).catch(() => '')).trim() : ''
      if (entry.serial.startsWith('emulator-')) {
        const avd = ok ? (await adb(['-s', entry.serial, 'emu', 'avd', 'name']).catch(() => '')).split('\n')[0]!.trim() : ''
        if (!avd) continue
        running.add(avd)
        devices.push({ platform: 'android', kind: 'simulator', udid: avd, name: avd.replace(/_/g, ' '), state: 'booted', os })
      } else {
        devices.push({
          platform: 'android',
          kind: 'device',
          udid: entry.serial,
          name: entry.model ?? entry.serial,
          state: ok ? 'connected' : 'unavailable',
          transport: adbTransport(entry.serial),
          os: ok ? os : entry.state // "unauthorized": accept the prompt on the phone
        })
      }
    }
  } catch (e) {
    return { devices, error: `adb: ${(e as Error).message}` }
  }
  // AVDs that are not running.
  const emulator = join(sdkDir(), 'emulator/emulator')
  const avds = existsSync(emulator)
    ? (await exec(emulator, ['-list-avds'], { timeoutMs: 10_000 }).then((r) => r.stdout).catch(() => '')).split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' '))
    : []
  for (const avd of avds) {
    if (running.has(avd)) continue
    const config = await readFile(join(homedir(), '.android/avd', `${avd}.avd`, 'config.ini'), 'utf8').catch(() => '')
    const api = avdApiLevel(config)
    devices.push({ platform: 'android', kind: 'simulator', udid: avd, name: avd.replace(/_/g, ' '), state: 'shutdown', os: api ? `API ${api}` : '' })
  }
  return { devices }
}

export type AndroidRunRequest = {
  projectPath: string
  module: string
  variant: string
  destination: Destination
  statusFile: string
  logFile: string
  openEmulatorPane: boolean
}

export async function startAndroidRun(request: AndroidRunRequest, outFile: string): Promise<number> {
  const script = await writeScript('android-run.sh', ANDROID_RUN_SCRIPT)
  const args = [
    request.statusFile,
    request.destination.kind,
    request.destination.udid,
    request.projectPath,
    request.module,
    request.variant,
    request.openEmulatorPane ? '1' : '0',
    request.logFile,
    sdkDir(),
    javaHome()
  ]
  return spawnRunner(script, args, request.projectPath, outFile)
}

/**
 * The Android runner, the counterpart of ios.ts's RUN_SCRIPT, with the same status words.
 * Steps: start the emulator (or check the phone), `gradlew :module:assembleVariant`, `adb install`,
 * launch the launcher activity, then follow the app's logcat until its process ends; a crash in
 * logcat's crash buffer marks the run `crashed:<file>`.
 * No `${` anywhere (String.raw still interpolates).
 */
export const ANDROID_RUN_SCRIPT = String.raw`#!/bin/bash
# Mobile Launchpad Android runner. Written by the Mobile Launchpad Orca plugin; rewritten on every run.
set -o pipefail
STATUS="$1"; KIND="$2"; TARGET="$3"; PROJECT="$4"; MODULE="$5"; VARIANT="$6"; OPEN_PANE="$7"; LOG="$8"; SDK="$9"
shift 9
JDK="$1"
: > "$LOG"
export ANDROID_HOME="$SDK"
STUDIO_JDK="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
if [ -z "$JAVA_HOME" ] && [ -z "$JDK" ] && [ -d "$STUDIO_JDK" ]; then JDK="$STUDIO_JDK"; fi
if [ -z "$JAVA_HOME" ] && [ -n "$JDK" ]; then export JAVA_HOME="$JDK"; fi
if [ -z "$JAVA_HOME" ] && ! /usr/libexec/java_home > /dev/null 2>&1; then
  printf '✗ No Java found: install Android Studio, or set JAVA_HOME\n' >> "$LOG"; printf 'failed:No Java found (install Android Studio, or set JAVA_HOME)\n' > "$STATUS"; exit 1
fi
ADB="$SDK/platform-tools/adb"
PKG=""

status() { printf '%s\n' "$*" > "$STATUS"; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; printf '▸ %s\n' "$*" >> "$LOG"; }
fail() { printf '✗ %s\n' "$*" >> "$LOG"; status "failed:$*"; printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }
stop_app() { if [ -n "$PKG" ] && [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" shell am force-stop "$PKG" > /dev/null 2>&1; fi; }
trap 'stop_app; status stopped; printf "\n\033[33m■ Stopped\033[0m\n"; exit 130' INT TERM

cd "$PROJECT" || fail "Project folder not found: $PROJECT"
[ -x "$ADB" ] || fail "adb not found in $SDK (set ANDROID_HOME, or install the SDK from Android Studio)"

# The serial of the running emulator whose AVD is $TARGET.
emulator_serial() {
  for s in $("$ADB" devices | awk '/^emulator-/ && $2 == "device" { print $1 }'); do
    if [ "$("$ADB" -s "$s" emu avd name 2> /dev/null | head -1 | tr -d '\r')" = "$TARGET" ]; then printf '%s' "$s"; return; fi
  done
}

status preparing
SERIAL=""
if [ "$KIND" = "simulator" ]; then
  SERIAL="$(emulator_serial)"
  if [ -z "$SERIAL" ]; then
    step "Starting emulator $TARGET"
    # Orca's emulator pane starts it when it can; otherwise start it ourselves.
    if [ "$OPEN_PANE" = "1" ] && command -v orca > /dev/null 2>&1; then orca emulator attach "$TARGET" > /dev/null 2>&1; fi
    for i in $(seq 1 20); do SERIAL="$(emulator_serial)"; [ -n "$SERIAL" ] && break; sleep 1; done
    if [ -z "$SERIAL" ]; then
      nohup "$SDK/emulator/emulator" -avd "$TARGET" > /dev/null 2>&1 &
      for i in $(seq 1 180); do SERIAL="$(emulator_serial)"; [ -n "$SERIAL" ] && break; sleep 1; done
    fi
    [ -n "$SERIAL" ] || fail "Could not start the emulator $TARGET"
  fi
  step "Waiting for $TARGET to boot"
  for i in $(seq 1 240); do
    [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = "1" ] && break
    sleep 1
  done
  [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = "1" ] || fail "$TARGET did not finish booting"
  if [ "$OPEN_PANE" = "1" ] && command -v orca > /dev/null 2>&1; then orca emulator attach "$SERIAL" > /dev/null 2>&1; fi
else
  SERIAL="$TARGET"
  STATE="$("$ADB" -s "$SERIAL" get-state 2>&1 | tr -d '\r')"
  case "$STATE" in
    device) ;;
    *unauthorized*) fail "Allow USB debugging on the phone (it shows a prompt), then run again" ;;
    *) fail "The phone is not connected ($STATE)" ;;
  esac
fi
export ANDROID_SERIAL="$SERIAL"

status building
CAP="$(printf '%s' "$VARIANT" | cut -c1 | tr '[:lower:]' '[:upper:]')$(printf '%s' "$VARIANT" | cut -c2-)"
step "Building $MODULE ($VARIANT)"
MARK="$LOG.start"
touch "$MARK"
[ -x ./gradlew ] || fail "gradlew not found in $PROJECT"
./gradlew "$MODULE:assemble$CAP" --console=plain 2>&1 | tee -a "$LOG" || fail "Build failed"

MODDIR="$(printf '%s' "$MODULE" | sed 's#^:##; s#:#/#g')"
APK="$(find "$MODDIR/build/outputs/apk" -name '*.apk' -newer "$MARK" 2> /dev/null | grep -v androidTest | head -1)"
[ -n "$APK" ] || APK="$(ls -t "$MODDIR"/build/outputs/apk/*/*.apk "$MODDIR"/build/outputs/apk/*/*/*.apk 2> /dev/null | grep -v androidTest | head -1)"
[ -n "$APK" ] || fail "The build made no APK (looked in $MODDIR/build/outputs/apk)"

status installing
step "Installing $(basename "$APK")"
INSTALL="$("$ADB" -s "$SERIAL" install -r -t "$APK" 2>&1)"
printf '%s\n' "$INSTALL" | tee -a "$LOG"
if ! printf '%s' "$INSTALL" | grep -q Success; then
  if printf '%s' "$INSTALL" | grep -q INSTALL_FAILED_UPDATE_INCOMPATIBLE; then
    fail "Could not install: the installed app has another signature (uninstall it first)"
  fi
  fail "Could not install: $(printf '%s' "$INSTALL" | grep -E 'Failure|Error' | tail -1)"
fi

AAPT="$(ls -d "$SDK"/build-tools/*/ 2> /dev/null | sort -V | tail -1)aapt2"
PKG="$("$AAPT" dump packagename "$APK" 2> /dev/null | tr -d '\r')"
[ -n "$PKG" ] || fail "Could not read the package name from $APK"

status launching
step "Launching $PKG (Stop in Mobile Launchpad ends the app)"
"$ADB" -s "$SERIAL" shell am force-stop "$PKG" > /dev/null 2>&1
"$ADB" -s "$SERIAL" logcat -b crash -c > /dev/null 2>&1
ACTIVITY="$("$ADB" -s "$SERIAL" shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$PKG" 2> /dev/null | tr -d '\r' | tail -1)"
case "$ACTIVITY" in */*) ;; *) fail "$PKG has no launcher activity" ;; esac
"$ADB" -s "$SERIAL" shell am start -W -n "$ACTIVITY" 2>&1 | tee -a "$LOG" | grep -q "Error" && fail "Could not launch the app"

APP_PID=""
for i in $(seq 1 20); do
  APP_PID="$("$ADB" -s "$SERIAL" shell pidof "$PKG" 2> /dev/null | tr -d '\r')"
  [ -n "$APP_PID" ] && break
  sleep 0.5
done
status running
if [ -n "$APP_PID" ]; then
  "$ADB" -s "$SERIAL" logcat -v color --pid="$APP_PID" &
  LOGCAT=$!
  while "$ADB" -s "$SERIAL" shell pidof "$PKG" > /dev/null 2>&1; do sleep 2; done
  kill "$LOGCAT" 2> /dev/null
fi

# The app's process ended: a crash leaves its stack in logcat's crash buffer.
sleep 1
CRASH_FILE="$LOG.crash.txt"
"$ADB" -s "$SERIAL" logcat -b crash -d 2> /dev/null > "$CRASH_FILE"
if grep -q "Process: $PKG" "$CRASH_FILE"; then
  status "crashed:$CRASH_FILE"
  printf '\n\033[1;31m💥 %s crashed\033[0m\n' "$PKG"
  grep -m 4 -E "FATAL EXCEPTION|Process:|Exception|Error" "$CRASH_FILE"
  exit 1
fi
status exited
printf '\n\033[2m● The app exited\033[0m\n'
`
