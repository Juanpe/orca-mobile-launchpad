import { assert, mockHost, mount, test } from 'orca/testing'
import type { Device, LaunchpadState } from './types'
import * as panel from './panel'
import { progressOf } from './panel'

const STATE: LaunchpadState = {
  workspace: { id: 'ws-1', name: 'bill-customer', branch: 'feature/bill', path: '/w' },
  projects: [{ platform: 'ios', kind: 'workspace', path: '/w/App.xcworkspace', label: 'App.xcworkspace' }],
  config: { project: '/w/App.xcworkspace', scheme: 'App', configuration: 'Debug' },
  run: { phase: 'idle' },
  otherRuns: [],
  canNavigate: true
}

const DEVICES: Device[] = [
  { platform: 'ios', kind: 'device', udid: 'U2', name: 'Wifi iPhone', state: 'connected', transport: 'wifi', os: '27.2' },
  { platform: 'ios', kind: 'simulator', udid: 'A', name: 'iPhone 18 Pro', state: 'booted', os: '27.0', deviceTypeId: 'dt', runtimeId: 'rt' }
]

const opened: string[] = []

function host(onUpdate?: (patch: unknown) => void, onRun?: () => void, initial: LaunchpadState = STATE) {
  let state = initial
  return mockHost({
    requests: {
      'state.get': () => state,
      'schemes.list': () => ({ schemes: ['App', 'AppKit', 'AppTests'], appSchemes: ['App'] }),
      'log.open': ({ kind }) => {
        opened.push(kind)
        return { opened: true }
      },
      'devices.list': () => ({ devices: DEVICES }),
      'config.update': (patch) => {
        onUpdate?.(patch)
        state = { ...state, config: { ...state.config, ...patch } }
        return state
      },
      run: () => {
        onRun?.()
        state = { ...state, run: { phase: 'building', scheme: 'App', destinationName: 'Wifi iPhone' } }
        return state
      },
      stop: () => state,
      'simulator.createForWorktree': () => ({ state, device: DEVICES[1]! })
    }
  })
}

test('draws the worktree, its devices and the worktree simulator button', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ type: 'Heading', text: 'App' }))
  const drawn = JSON.stringify(view.tree())
  assert.ok(drawn.indexOf('"title":"Build"') < drawn.indexOf('Simulators ·'), 'Build settings sit above the destination picker')
  assert.ok(view.find({ type: 'Button', text: 'Simulator for this worktree' }))
  assert.ok(view.find({ type: 'ListItem', label: /iPhone 18 Pro/ }))
  await view.select({ type: 'Tabs' }, 'devices')
  assert.ok(view.find({ type: 'ListItem', label: /Wifi iPhone/ }))
  assert.ok(JSON.stringify(view.tree()).includes('iOS 27.2 · Wi-Fi'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('picking a device saves it as the destination; Build & Run asks the worker', async () => {
  const patches: unknown[] = []
  let runs = 0
  const view = await mount(panel, { host: host((p) => patches.push(p), () => runs++) })
  await view.select({ type: 'Tabs' }, 'devices')
  await view.press({ type: 'ListItem', label: /Wifi iPhone/ })
  assert.deepEqual(patches, [{ destination: { platform: 'ios', kind: 'device', udid: 'U2', name: 'Wifi iPhone' } }])
  await view.press({ type: 'Button', text: 'Run' })
  assert.equal(runs, 1)
  await view.post('state.changed', { ...STATE, run: { phase: 'building', scheme: 'App', destinationName: 'Wifi iPhone' } })
  assert.ok(view.find({ type: 'Badge', text: 'Building' }))
  assert.ok(view.find({ type: 'Progress' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Relaunch' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('empty state without an Xcode project', async () => {
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'state.get': () => ({ ...STATE, projects: [], config: { configuration: 'Debug' } }),
        'devices.list': () => ({ devices: [] })
      }
    })
  })
  assert.match(view.summary().join('\n'), /No mobile app here/)
  await view.unmount()
})

test('a failed build shows its errors, the log and opens it in Console', async () => {
  const failed: LaunchpadState = {
    ...STATE,
    run: {
      phase: 'failed',
      scheme: 'App',
      message: 'Build failed',
      errors: ['Foo.swift:12:5: error: cannot find Bar in scope'],
      logTail: 'line 1\nline 2',
      logPath: '/tmp/build.log'
    }
  }
  opened.length = 0
  const view = await mount(panel, { host: host(undefined, undefined, failed) })
  const drawn = JSON.stringify(view.tree())
  assert.ok(drawn.includes('cannot find Bar in scope'))
  assert.ok(view.find({ type: 'Collapsible' , label: /Build log/ }) ?? drawn.includes('Build log'))
  await view.press({ type: 'Button', text: 'Open full log in Console' })
  assert.deepEqual(opened, ['build'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a crash shows the report summary', async () => {
  const crashed: LaunchpadState = {
    ...STATE,
    run: { phase: 'crashed', scheme: 'App', crashTitle: 'EXC_BAD_ACCESS (SIGSEGV)', crashSummary: 'App — EXC_BAD_ACCESS', crashPath: '/tmp/App.ips' }
  }
  opened.length = 0
  const view = await mount(panel, { host: host(undefined, undefined, crashed) })
  assert.ok(JSON.stringify(view.tree()).includes('EXC_BAD_ACCESS (SIGSEGV)'))
  await view.press({ type: 'Button', text: 'Open crash report in Console' })
  assert.deepEqual(opened, ['crash'])
  await view.unmount()
})

test('a scheme that builds no app gets a warning with the app scheme', async () => {
  const patches: unknown[] = []
  const library: LaunchpadState = { ...STATE, config: { ...STATE.config, scheme: 'AppKit' } }
  const view = await mount(panel, { host: host((p) => patches.push(p), undefined, library) })
  assert.match(view.summary().join('\n'), /AppKit doesn't build an app/)
  await view.press({ type: 'Button', text: 'Use App' })
  assert.deepEqual(patches, [{ scheme: 'App' }])
  await view.unmount()
})

test('progress follows the phase and the last build time', () => {
  const t0 = 1_000_000
  assert.equal(progressOf({ phase: 'building', phaseStartedAt: t0, estimatedBuildMs: 100_000 }, t0), 12)
  const half = progressOf({ phase: 'building', phaseStartedAt: t0, estimatedBuildMs: 100_000 }, t0 + 50_000)
  assert.ok(half > 40 && half < 50, String(half))
  const late = progressOf({ phase: 'building', phaseStartedAt: t0, estimatedBuildMs: 100_000 }, t0 + 1_000_000)
  assert.ok(late < 84, String(late))
  assert.equal(progressOf({ phase: 'running' }, t0), 100)
})

test('runs in other worktrees stay visible, with progress, navigation and stop', async () => {
  const stops: unknown[] = []
  const shows: unknown[] = []
  const elsewhere: LaunchpadState = {
    ...STATE,
    projects: [],
    otherRuns: [
      {
        workspace: { id: 'ws-2', name: 'parity-kitchen', branch: 'feature/kitchen', path: '/w2' },
        run: { phase: 'building', scheme: 'Barista', platform: 'android', destinationName: 'Pixel 9', startedAt: 1, phaseStartedAt: Date.now(), terminalId: 't-2' }
      }
    ]
  }
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'state.get': () => elsewhere,
        'devices.list': () => ({ devices: [] }),
        stop: (input) => {
          stops.push(input)
          return { ...elsewhere, otherRuns: [] }
        },
        'worktree.show': (input) => {
          shows.push(input)
          return { shown: true }
        }
      }
    })
  })
  const summary = view.summary().join('\n')
  assert.match(summary, /No mobile app here/)
  assert.ok(view.find({ type: 'Heading', text: 'Other worktrees · 1' }))
  assert.ok(view.find({ type: 'Progress' }))
  assert.ok(view.find({ type: 'Text', text: 'Android' }))
  await view.press({ type: 'Button', text: 'Terminal' })
  assert.deepEqual(shows, [{ path: '/w2', terminal: true }])
  await view.press({ type: 'Button', text: 'Stop' })
  assert.deepEqual(stops, [{ path: '/w2' }])
  assert.equal(view.find({ type: 'Heading', text: 'Other worktrees · 1' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a device plugged in shows up without pressing refresh', async () => {
  let plugged = false
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'state.get': () => STATE,
        'schemes.list': () => ({ schemes: ['App'], appSchemes: ['App'] }),
        'devices.list': () => ({
          devices: plugged
            ? [{ platform: 'ios', kind: 'device', udid: 'U9', name: 'Cable iPhone', state: 'connected', transport: 'cable', os: '27.2' }]
            : []
        })
      }
    })
  })
  await view.select({ type: 'Tabs' }, 'devices')
  assert.equal(view.find({ type: 'ListItem', label: /Cable iPhone/ }), null)
  plugged = true
  await new Promise((resolve) => setTimeout(resolve, 3300))
  await view.settled()
  assert.ok(view.find({ type: 'ListItem', label: /Cable iPhone/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the destination chip folds the picker; picking a device folds it too', async () => {
  const view = await mount(panel, { host: host(() => undefined, () => undefined) })
  assert.ok(view.find({ type: 'Tabs' }), 'the picker starts open')
  await view.select({ type: 'Tabs' }, 'devices')
  await view.press({ type: 'ListItem', label: /Wifi iPhone/ })
  assert.deepEqual(view.errors, [])
  assert.equal(view.find({ type: 'Tabs' }), null, 'picking closes it')
  await view.press({ type: 'Button', text: /▾$/ })
  assert.ok(view.find({ type: 'Tabs' }), 'the chip opens it again')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
