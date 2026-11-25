import { assert, test } from 'orca/testing'
import {
  compareVersions,
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
  assert.equal(preferredScheme(['CoreTests', 'Qamarero', 'Pkg-Package'], '/x/Other.xcodeproj'), 'Qamarero')
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
