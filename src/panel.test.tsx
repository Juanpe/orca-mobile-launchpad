import { assert, mockHost, mount, test } from 'orca/testing'
import type { Device, LaunchpadState } from './types'
import * as panel from './panel'

const STATE: LaunchpadState = {
  workspace: { id: 'ws-1', name: 'bill-customer', branch: 'feature/bill', path: '/w' },
  projects: [{ platform: 'ios', kind: 'workspace', path: '/w/App.xcworkspace', label: 'App.xcworkspace' }],
  config: { project: '/w/App.xcworkspace', scheme: 'App', configuration: 'Debug' },
  run: { phase: 'idle' }
}

const DEVICES: Device[] = [
  { platform: 'ios', kind: 'device', udid: 'U2', name: 'Wifi iPhone', state: 'connected', transport: 'wifi', os: '27.2' },
  { platform: 'ios', kind: 'simulator', udid: 'A', name: 'iPhone 18 Pro', state: 'booted', os: '27.0', deviceTypeId: 'dt', runtimeId: 'rt' }
]

function host(onUpdate?: (patch: unknown) => void, onRun?: () => void) {
  let state = STATE
  return mockHost({
    requests: {
      'state.get': () => state,
      'schemes.list': () => ({ schemes: ['App', 'AppTests'] }),
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
  assert.ok(view.find({ type: 'Button', text: 'Simulador para este worktree' }))
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
  await view.press({ text: 'Build & Run' })
  assert.equal(runs, 1)
  await view.post('state.changed', { ...STATE, run: { phase: 'building', scheme: 'App', destinationName: 'Wifi iPhone' } })
  assert.ok(view.find({ type: 'Badge', text: 'Compilando' }))
  assert.ok(view.find({ type: 'Progress' }))
  assert.ok(view.find({ text: 'Relanzar' }))
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
  assert.match(view.summary().join('\n'), /Aquí no hay app móvil/)
  await view.unmount()
})
