# Mobile Launchpad

An [Orca](https://github.com/stablyai/orca) plugin to **Build & Run the active worktree's mobile app**
on an iOS simulator or an iPhone connected by cable or Wi-Fi, from the status bar. It only shows up
in worktrees that contain a mobile project (iOS today, Android next).

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
  `⠋ 1 building elsewhere`.
- **Command palette**: `Mobile Launchpad: Build & Run` (`Mod+Alt+R`) and `Mobile Launchpad: Stop`.

## How it works

The worker looks for an `.xcworkspace`/`.xcodeproj` at the worktree root or in a conventional mobile
folder (`ios/`, `iosApp/`, `apple/`, `app/`, `mobile/ios/`, `apps/ios/`…). A folder that only
contains other repositories does not count. A run starts a script in its own process group, apart
from any terminal, and opens an Orca terminal in that worktree that follows its output (`tail -F`).
Closing or interrupting that terminal leaves the build running; "Terminal" in the panel opens it
again. The script:

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
- `fixtures/demo-worktree`: a fake worktree for `orca plugin check` / `plugin shot --scenario demo`.

## Android (next)

Platform logic lives in `src/platforms/`. An `android.ts` adapter would offer the same: detect
`gradlew` + `settings.gradle(.kts)`, list with `adb devices -l` and `emulator -list-avds` (Wi-Fi via
`adb pair`/`adb connect`), and launch with `./gradlew :app:installDebug` + `adb shell am start`. What
is left is adding `'android'` to `Platform` and letting the worker pick the adapter per project.
