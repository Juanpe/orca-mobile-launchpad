import { assert, test } from 'orca/testing'
import type { Device } from '../types'
import { availableDevice, chooseDestination } from './index'

const sim: Device = { platform: 'ios', kind: 'simulator', udid: 'A', name: 'iPhone 18', state: 'booted', os: '27.0' }
const shutSim: Device = { ...sim, udid: 'B', name: 'iPhone 17', state: 'shutdown' }
const phone: Device = { platform: 'ios', kind: 'device', udid: 'P', name: 'Test iPhone', state: 'connected', os: '27.0', transport: 'wifi' }
const offline: Device = { ...phone, udid: 'Q', name: 'Old iPhone', state: 'unavailable' }
const emulator: Device = { platform: 'android', kind: 'simulator', udid: 'Pixel_9', name: 'Pixel 9', state: 'booted', os: '16' }
const devices = [sim, shutSim, phone, offline, emulator]

test('a destination is available when listed, and connected if it is a phone', () => {
  assert.equal(availableDevice(shutSim, devices), shutSim)
  assert.equal(availableDevice(phone, devices), phone)
  assert.equal(availableDevice(offline, devices), undefined)
  assert.equal(availableDevice({ ...sim, udid: 'gone' }, devices), undefined)
  assert.equal(availableDevice({ ...emulator, platform: 'ios' }, devices), undefined)
})

test('the worktree destination first, then the last used one, then the first sensible one', () => {
  assert.equal(chooseDestination('ios', devices, 'web', shutSim, phone), shutSim)
  assert.equal(chooseDestination('ios', devices, 'web', undefined, phone), phone)
  assert.equal(chooseDestination('ios', devices, 'web', offline, phone), phone)
  assert.equal(chooseDestination('ios', devices, 'web', offline, offline), sim)
  assert.equal(chooseDestination('ios', devices, 'web', undefined, undefined), sim)
  // The last used device of the other platform does not count.
  assert.equal(chooseDestination('android', devices, 'web', undefined, phone), emulator)
  assert.equal(chooseDestination('android', [sim], 'web', undefined, emulator), undefined)
})
