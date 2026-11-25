# Mobile Launchpad

An [Orca](https://github.com/stablyai/orca) plugin to **Build & Run the active worktree's mobile app**
on an iOS simulator, an Android emulator, or a phone connected by cable or Wi-Fi, from the status
bar. It only shows up in worktrees that contain a mobile project (an Xcode project or a Gradle build).

- **Status bar**: `🚀 MyApp · iPhone 18 Pro`. Click to build and run; while building it shows the
  phase and progress (`⠋ Building 42% · iPhone`), turns green while the app runs and red if it fails.
- **Mobile Launchpad panel** (right sidebar): a launch card with status, progress and elapsed time,
  the build settings (project, scheme, configuration) and the destination picker (simulators and
  devices), which refreshes itself every 3 seconds while the panel is visible: an iPhone plugged in
  or switched to cable shows up on its own. Each worktree remembers its own settings.
- **Simulator per worktree**: "Simulator for this worktree" creates `<worktree> iPhone` with the
  model and iOS version of the selected simulator, so several branches can run side by side.
- **Runs in other worktrees** stay visible: the panel lists them under "Other worktrees" with their
  progress, failure or crash, and Stop / Go to worktree / Terminal; the status bar adds
  `⠋ +1 elsewhere` (or shows `⠋ 1 building elsewhere` in a worktree without an app).
- **iOS and Android**: a worktree with both apps shows an `iOS · Android` switch on the launch card;
  each platform lists its own destinations (simulators and iPhones, or emulators and Android phones)
  and its own build settings (scheme and configuration, or app module and build variant).
- **Command palette**: `Mobile Launchpad: Build & Run` (`Mod+Alt+R`) and `Mobile Launchpad: Stop`.

## `launchpad` command (for agents)

The plugin writes a `launchpad` command so an agent (or a script) can run the app of the worktree it
works in, through the same plugin: the run shows up in the panel and the status bar, with the
worktree's saved scheme, configuration and destination.

```sh
launchpad run                        # waits until the app runs; exit 0, or 1 with the build errors
launchpad run --device               # on the first connected iPhone (--device "18 Pro" to pick one)
launchpad run --simulator            # on the worktree's simulator, or a booted one
launchpad run --configuration Release --follow   # print the build output as it goes
launchpad status | stop | devices
```

Exit codes: 0 running (or ran and exited), 1 build or launch failed, 2 crashed, 3 Orca or the plugin
not reachable, 4 bad usage, 130 stopped. `launchpad --help` has the rest.

The command lives in the plugin's work folder (`$TMPDIR/orca-launchpad/launchpad`), rewritten each
time the plugin starts; put it on your PATH once:

```sh
ln -sf "$TMPDIR/orca-launchpad/launchpad" ~/.local/bin/launchpad
```

It talks to the plugin through files in `$TMPDIR/orca-launchpad/requests` (only your user can read
it): a request per call, which the plugin picks up within a second. Orca must be open.

A line for an agent's skill: *To try the app, run `launchpad run` (add `--device` for the iPhone). If
it exits 1, fix the build errors it prints and run it again.*

## How it works

The worker looks for an `.xcworkspace`/`.xcodeproj` at the worktree root or in a conventional mobile
folder (`ios/`, `iosApp/`, `apple/`, `app/`, `mobile/ios/`, `apps/ios/`…). A folder that only
contains other repositories does not count. A run starts a script in its own process group, apart
from any terminal, and opens an Orca terminal in that worktree that follows its output (`tail -F`).
Closing or interrupting that terminal leaves the build running; "Terminal" in the panel opens it
again. The terminal returns to its prompt when the run ends, so Orca does not show the worktree as
busy. Runs are kept in the plugin's storage, so a reinstall or reload picks them up again. The script:

1. Simulator: `simctl bootstatus -b`, then shows it in Orca's emulator pane (`orca emulator attach`),
   or in Simulator.app when installed.
2. `xcodebuild build` (through `xcbeautify` when it actually runs; otherwise `-quiet`). On a device it
   adds `-allowProvisioningUpdates`. It uses Xcode's default DerivedData, so it shares the build cache
   with Xcode.
3. Installs and launches with the app's console in the terminal:
   - Simulator: `simctl install` + `simctl launch --console`.
   - iPhone: `devicectl device install app` + `devicectl device process launch --console`.

The script writes its phase to a status file that the worker reads every second to update the status
bar. Stop (panel or palette) ends the script's process group: the build, or the app it launched.
Relaunching does the same and closes the previous terminal.

## Install

Orca copies a folder install as is and refuses `node_modules`' symlinks, so install a clean export of
the last commit:

```sh
npm run release:install   # git archive HEAD → temp folder → orca plugin install (asks for --approve)
```

Orca keeps its own copy under `~/Library/Application Support/orca/plugins/`; reinstall after changes.

## Development

```sh
npm install            # TypeScript and Node types, only for `npm run typecheck`
npm run typecheck
orca plugin test . --json
orca plugin check . --json
orca plugin dev watch . --check --json   # load into Orca and reload on save
```

Layout:

- `src/worker.ts`: per-worktree state, status bar, commands and panel requests.
- `src/panel.tsx`: the panel (Orca components, no build step).
- `src/platforms/ios.ts`: the iOS adapter (projects, schemes, devices, run script).
- `src/platforms/ios-parse.ts`: pure parsers for `simctl`, `devicectl` and `xcodebuild -list`.
- `src/platforms/android.ts` / `android-parse.ts`: the Android adapter and its parsers (adb, Gradle).
- `src/platforms/index.ts`: picks the adapter by the project's platform.
- `src/platforms/runner.ts`: starts a run script in its own process group and follows its output.
- `fixtures/demo-worktree`: a fake worktree for `orca plugin check` / `plugin shot --scenario demo`.

## Android

The worker looks for a Gradle build (`settings.gradle(.kts)` with at least one module that applies
`com.android.application`) at the root or in `android/`, `androidApp/`, `mobile/android/`,
`apps/android/`… The panel offers the app modules and their build variants (build types × product
flavors, read from the module's build file), the AVDs (`emulator -list-avds`) and the phones
`adb devices -l` sees, over USB or wireless debugging. The SDK comes from `ANDROID_HOME`,
`ANDROID_SDK_ROOT` or `~/Library/Android/sdk`; Gradle gets Android Studio's JDK when `JAVA_HOME` is
unset. The run script (`android-run.sh`):

1. Emulator: starts the AVD in Orca's emulator pane (`orca emulator attach`), or with `emulator -avd`
   when that does not work, and waits for `sys.boot_completed`.
2. `./gradlew :module:assemble<Variant> --console=plain`.
3. `adb install -r -t`, reads the package with `aapt2`, launches its launcher activity
   (`am start -W`) and prints the app's `logcat` until its process ends.
4. A crash in logcat's crash buffer marks the run crashed, with the exception in the panel.

`launchpad run --android` (or `--ios`) picks the app when the worktree has both.
