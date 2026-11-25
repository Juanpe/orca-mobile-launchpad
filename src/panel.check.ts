// `orca plugin check` (and `orca plugin shot . --scenario <name>`) render the panel per scenario
// with the real worker on a stand-in host. `demo` points the worker at fixtures/demo-worktree.
import { defineCheck } from 'orca/testing'
import type { Device, LaunchpadState, OtherRun } from './types'

const demo = new URL('../fixtures/demo-worktree', import.meta.url).pathname
const context = { workspaceId: 'ws-demo', branch: 'feature/checkout', displayName: 'bill-customer', terminals: [] }
const workspaces = {
  workspaces: [{ id: 'ws-demo', kind: 'worktree', name: 'bill-customer', path: demo, branch: 'feature/checkout', hostId: 'local' }],
  truncated: false
}

// ── Showcase: made-up app, worktrees and devices for the README and store screenshots ───────────

const now = Date.now()
const W = '/Users/dev/brewlog/worktrees'
const IOS_PROJECT = { platform: 'ios', kind: 'workspace', path: `${W}/latte-art/Brewlog.xcworkspace`, label: 'Brewlog.xcworkspace' } as const
const ANDROID_PROJECT = { platform: 'android', kind: 'gradle', path: `${W}/latte-art/android`, label: 'android', name: 'Brewlog' } as const

const DEVICES: Device[] = [
  { platform: 'ios', kind: 'simulator', udid: 'S1', name: 'latte-art iPhone', state: 'booted', os: '27.0' },
  { platform: 'ios', kind: 'simulator', udid: 'S2', name: 'iPhone 18 Pro', state: 'booted', os: '27.0' },
  { platform: 'ios', kind: 'simulator', udid: 'S3', name: 'iPad Air 13-inch (M4)', state: 'shutdown', os: '27.0' },
  { platform: 'ios', kind: 'simulator', udid: 'S4', name: 'iPhone 18', state: 'shutdown', os: '27.0' },
  { platform: 'ios', kind: 'simulator', udid: 'S5', name: 'iPhone SE (4th generation)', state: 'shutdown', os: '26.5' },
  { platform: 'ios', kind: 'device', udid: 'D1', name: 'Alex’s iPhone 18 Pro', state: 'connected', transport: 'cable', os: '27.2' },
  { platform: 'ios', kind: 'device', udid: 'D2', name: 'Test iPhone 16e', state: 'connected', transport: 'wifi', os: '27.1' },
  { platform: 'ios', kind: 'device', udid: 'D3', name: 'Alex’s iPad', state: 'unavailable', os: '26.4' },
  { platform: 'android', kind: 'simulator', udid: 'Pixel_10_Pro', name: 'Pixel 10 Pro', state: 'booted', os: '16' },
  { platform: 'android', kind: 'simulator', udid: 'Pixel_Tablet', name: 'Pixel Tablet', state: 'shutdown', os: 'API 36' },
  { platform: 'android', kind: 'simulator', udid: 'Small_Phone', name: 'Small Phone', state: 'shutdown', os: 'API 34' },
  { platform: 'android', kind: 'device', udid: '3A281FDH', name: 'Pixel 9a', state: 'connected', transport: 'cable', os: '16' }
]

const OTHERS: OtherRun[] = [
  {
    workspace: { id: 'ws-2', name: 'oat-milk-sync', branch: 'feature/oat-milk-sync', path: `${W}/oat-milk-sync` },
    run: { phase: 'running', platform: 'android', scheme: 'Brewlog', destinationName: 'Pixel 10 Pro', startedAt: now - 6 * 60_000, terminalId: 't-2' }
  },
  {
    workspace: { id: 'ws-3', name: 'grinder-presets', branch: 'fix/grinder-presets', path: `${W}/grinder-presets` },
    run: { phase: 'building', platform: 'ios', scheme: 'Brewlog', destinationName: 'grinder-presets iPhone', startedAt: now - 38_000, phaseStartedAt: now - 33_000, estimatedBuildMs: 95_000, terminalId: 't-3' }
  }
]

function showcase(state: LaunchpadState, pickerOpen: boolean, tab: 'simulators' | 'devices' = 'simulators') {
  const android = state.projects.find((p) => p.path === state.config.project)?.platform === 'android'
  return {
    requests: {
      'state.get': state,
      'devices.list': { devices: DEVICES },
      'schemes.list': android
        ? { schemes: [':app', ':core', ':designsystem'], appSchemes: [':app'], configurations: ['debug', 'release', 'staging'] }
        : { schemes: ['Brewlog', 'BrewlogKit', 'BrewlogWidgets'], appSchemes: ['Brewlog', 'BrewlogWidgets'], configurations: ['Debug', 'Release'] }
    },
    results: { 'workspace.readContext': null },
    persisted: { plugin: { pickerOpen, destinationTab: tab } }
  }
}

const latteArt = { id: 'ws-1', name: 'latte-art', branch: 'feature/latte-art-timer', path: `${W}/latte-art` }
const iosConfig = {
  project: IOS_PROJECT.path,
  scheme: 'Brewlog',
  configuration: 'Debug',
  destination: { platform: 'ios', kind: 'device', udid: 'D1', name: 'Alex’s iPhone 18 Pro' }
} as const

export default defineCheck({
  showcaseBuilding: showcase(
    {
      workspace: latteArt,
      projects: [IOS_PROJECT, ANDROID_PROJECT],
      config: iosConfig,
      run: { phase: 'building', platform: 'ios', scheme: 'Brewlog', destinationName: 'Alex’s iPhone 18 Pro', startedAt: now - 52_000, phaseStartedAt: now - 47_000, estimatedBuildMs: 90_000, terminalId: 't-1' },
      otherRuns: OTHERS,
      canNavigate: true
    },
    false
  ),
  showcaseDevices: showcase(
    {
      workspace: latteArt,
      projects: [IOS_PROJECT, ANDROID_PROJECT],
      config: iosConfig,
      run: { phase: 'running', platform: 'ios', scheme: 'Brewlog', destinationName: 'Alex’s iPhone 18 Pro', startedAt: now - 4 * 60_000, terminalId: 't-1' },
      otherRuns: [],
      canNavigate: true
    },
    true,
    'devices'
  ),
  showcaseAndroid: showcase(
    {
      workspace: latteArt,
      projects: [IOS_PROJECT, ANDROID_PROJECT],
      config: { project: ANDROID_PROJECT.path, scheme: ':app', configuration: 'debug', destination: { platform: 'android', kind: 'simulator', udid: 'Pixel_10_Pro', name: 'Pixel 10 Pro' } },
      run: { phase: 'idle' },
      otherRuns: [],
      canNavigate: true
    },
    true
  ),
  showcaseFailed: showcase(
    {
      workspace: latteArt,
      projects: [IOS_PROJECT, ANDROID_PROJECT],
      config: { ...iosConfig, destination: { platform: 'ios', kind: 'simulator', udid: 'S1', name: 'latte-art iPhone' } },
      run: {
        phase: 'failed',
        platform: 'ios',
        scheme: 'Brewlog',
        destinationName: 'latte-art iPhone',
        startedAt: now - 70_000,
        finishedAt: now - 20_000,
        message: 'Build failed',
        errors: [
          'TimerView.swift:42:18: error: cannot find \'brewRatio\' in scope',
          'TimerView.swift:57:9: error: missing argument for parameter \'grams\' in call'
        ],
        logPath: '/tmp/build.log'
      },
      otherRuns: [],
      canNavigate: true
    },
    false
  ),
  noWorkspace: { results: { 'workspace.readContext': null } },
  demo: {
    results: { 'workspace.readContext': context, 'workspace.list': workspaces },
    storage: {
      [`config:${demo}`]: {
        configuration: 'Debug',
        scheme: 'DemoApp',
        destination: { platform: 'ios', kind: 'simulator', udid: '5E221A5A-5ED0-4A75-A7B4-91E8B16F090B', name: 'iPhone 18 Pro' }
      }
    }
  }
})
