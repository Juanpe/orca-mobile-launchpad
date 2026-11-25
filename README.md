# Mobile Launchpad

An [Orca](https://github.com/stablyai/orca) plugin to **Build & Run the active worktree's mobile app**
on an iOS simulator or an iPhone connected by cable or Wi-Fi, from the status bar. It only shows up
in worktrees that contain a mobile project (iOS today, Android next).

- **Status bar**: `🚀 MyApp · iPhone 18 Pro`. Click to build and run; while building it shows the
  phase (`Building… · iPhone`), turns green while the app runs and red if it fails.
- **Mobile Launchpad panel** (right sidebar): a launch card with status, progress and elapsed time,
  the build settings (project, scheme, configuration) and the destination picker (simulators and
  devices). Each worktree remembers its own settings.
- **Simulator per worktree**: "Simulator for this worktree" creates `<worktree> iPhone` with the
  model and iOS version of the selected simulator, so several branches can run side by side.
- **Command palette**: `Mobile Launchpad: Build & Run` (`Mod+Alt+R`) and `Mobile Launchpad: Stop`.

## How it works

The worker looks for an `.xcworkspace`/`.xcodeproj` at the worktree root or in a conventional mobile
folder (`ios/`, `iosApp/`, `apple/`, `app/`, `mobile/ios/`, `apps/ios/`…). A folder that only
contains other repositories does not count. A run opens an Orca terminal in that worktree that runs a
script:

1. Simulator: `simctl bootstatus -b`, then shows it in Orca's emulator pane (`orca emulator attach`),
   or in Simulator.app when installed.
2. `xcodebuild build` (through `xcbeautify` when it actually runs; otherwise `-quiet`). On a device it
   adds `-allowProvisioningUpdates`. It uses Xcode's default DerivedData, so it shares the build cache
   with Xcode.
3. Installs and launches with the app's console in the terminal:
   - Simulator: `simctl install` + `simctl launch --console-pty`.
   - iPhone: `devicectl device install app` + `devicectl device process launch --console`.

The script writes its phase to a status file that the worker reads every second to update the status
bar. Ctrl-C in the terminal (or Stop) stops the app. Relaunching closes the previous terminal.

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
