import { assert, test } from 'orca/testing'
import {
  compareVersions,
  extractBuildErrors,
  logTail,
  schemeBuildsApp,
  summarizeCrash,
  parseDevicectlDevices,
  parseSchemes,
  parseSimctlDevices,
  preferredDestination,
  preferredScheme
} from './ios-parse'

const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid: 'A', name: 'iPhone 18 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'dt.iPhone-18-Pro' },
      { udid: 'B', name: 'bill-customer iPhone', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'dt.iPhone-18-Pro' }
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
      { udid: 'C', name: 'iPhone 18 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'dt.iPhone-18-Pro' }
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [
      { udid: 'W', name: 'Apple Watch', state: 'Shutdown', isAvailable: true }
    ]
  }
})

const DEVICECTL = JSON.stringify({
  result: {
    devices: [
      { identifier: 'S', hardwareProperties: { udid: 'S', reality: 'simulated', platform: 'iOS' }, deviceProperties: { name: 'Sim' } },
      { identifier: 'X1', connectionProperties: { tunnelState: 'unavailable' }, deviceProperties: { name: 'Old iPhone', osVersionNumber: '26.0' }, hardwareProperties: { udid: 'U1', reality: 'physical', platform: 'iOS' } },
      { identifier: 'X2', connectionProperties: { transportType: 'localNetwork', tunnelState: 'connected' }, deviceProperties: { name: 'Wifi iPhone', osVersionNumber: '27.2.1' }, hardwareProperties: { udid: 'U2', reality: 'physical', platform: 'iOS' } },
      { identifier: 'X3', connectionProperties: { transportType: 'wired', tunnelState: 'connected' }, deviceProperties: { name: 'Cable iPhone', osVersionNumber: '27.0' }, hardwareProperties: { udid: 'U3', reality: 'physical', platform: 'iOS' } },
      { identifier: 'X4', deviceProperties: { name: 'Watch' }, hardwareProperties: { udid: 'U4', reality: 'physical', platform: 'watchOS' } }
    ]
  }
})

test('simctl: iOS only, booted first, newest OS first for equal names', () => {
  const sims = parseSimctlDevices(SIMCTL)
  assert.deepEqual(sims.map((d) => `${d.udid}:${d.os}:${d.state}`), ['B:27.0:booted', 'C:27.1:shutdown', 'A:27.0:shutdown'])
  assert.equal(sims[0]!.runtimeId, 'com.apple.CoreSimulator.SimRuntime.iOS-27-0')
  assert.equal(sims[0]!.deviceTypeId, 'dt.iPhone-18-Pro')
})

test('devicectl: physical iOS only, with Wi-Fi or cable transport', () => {
  const devices = parseDevicectlDevices(DEVICECTL)
  assert.deepEqual(
    devices.map((d) => [d.udid, d.state, d.transport ?? null]),
    [
      ['U3', 'connected', 'cable'],
      ['U2', 'connected', 'wifi'],
      ['U1', 'unavailable', null]
    ]
  )
})

test('schemes: tolerates warnings before the JSON', () => {
  const out = 'warning: something\n' + JSON.stringify({ workspace: { name: 'App', schemes: ['App', 'AppTests'] } })
  assert.deepEqual(parseSchemes(out), ['App', 'AppTests'])
  assert.deepEqual(parseSchemes(JSON.stringify({ project: { schemes: ['Lib'] } })), ['Lib'])
})

test('preferred scheme: named like the project, else not a test scheme', () => {
  assert.equal(preferredScheme(['AppTests', 'App'], '/x/App.xcworkspace'), 'App')
  assert.equal(preferredScheme(['CoreTests', 'Brewlog', 'Pkg-Package'], '/x/Other.xcodeproj'), 'Brewlog')
})

test('preferred destination: worktree simulator, then booted iPhone, then newest iPhone', () => {
  const sims = parseSimctlDevices(SIMCTL)
  assert.equal(preferredDestination(sims, 'bill-customer iPhone')?.udid, 'B')
  assert.equal(preferredDestination(sims, 'nope iPhone')?.udid, 'B')
  const shutdown = sims.filter((d) => d.state !== 'booted')
  assert.equal(preferredDestination(shutdown, 'nope iPhone')?.udid, 'C')
})

test('compareVersions', () => {
  assert.ok(compareVersions('27.1', '27.0.5') > 0)
  assert.equal(compareVersions('27.0', '27.0.0'), 0)
})

test('preferred scheme: an app scheme beats a package scheme', () => {
  assert.equal(
    preferredScheme(['BrewlogAPI', 'BrewlogBarista', 'BrewlogBaristaApp'], '/x/Brewlog.xcworkspace', ['BrewlogBarista']),
    'BrewlogBarista'
  )
})

test('schemeBuildsApp reads BuildableName', () => {
  assert.equal(schemeBuildsApp('<BuildableReference BuildableName = "Barista.app" />'), true)
  assert.equal(schemeBuildsApp('<BuildableReference BuildableName = "BrewlogAPI" />'), false)
})

test('build errors: compiler errors, shortened paths, no duplicates', () => {
  const log = [
    'CompileSwift normal arm64 /Users/me/app/Sources/Foo.swift',
    '/Users/me/app/Sources/Foo.swift:12:5: error: cannot find Bar in scope',
    '/Users/me/app/Sources/Foo.swift:12:5: error: cannot find Bar in scope',
    'warning: something harmless',
    '** BUILD FAILED **'
  ].join('\n')
  assert.deepEqual(extractBuildErrors(log), ['Foo.swift:12:5: error: cannot find Bar in scope', '** BUILD FAILED **'])
})

test('log tail keeps whole lines within the limit', () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const tail = logTail(log, 10)
  assert.equal(tail.split('\n').length, 10)
  assert.ok(tail.endsWith('line 499'))
})

test('crash summary: exception, reason and the crashed thread', () => {
  const header = JSON.stringify({ app_name: 'Barista', timestamp: 'now' })
  const body = JSON.stringify({
    exception: { type: 'EXC_BREAKPOINT', signal: 'SIGTRAP' },
    asi: { libswiftCore: ['Fatal error: Index out of range'] },
    faultingThread: 1,
    threads: [{ frames: [] }, { queue: 'com.apple.main-thread', frames: [{ symbol: 'CartView.total', imageIndex: 0 }] }],
    usedImages: [{ name: 'Barista' }]
  })
  const { title, summary } = summarizeCrash(`${header}\n${body}`)
  assert.equal(title, 'EXC_BREAKPOINT (SIGTRAP)')
  assert.match(summary, /Fatal error: Index out of range/)
  assert.match(summary, /Thread 1 crashed \(com.apple.main-thread\)/)
  assert.match(summary, /Barista\s+CartView.total/)
})
