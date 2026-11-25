// Runs the worker over a mock host and a throwaway worktree folder with an Xcode project in it.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

async function fakeWorktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-test-'))
  await mkdir(join(root, 'App.xcodeproj', 'project.xcworkspace'), { recursive: true })
  await mkdir(join(root, 'App.xcworkspace'), { recursive: true })
  await mkdir(join(root, 'Pods', 'Pods.xcodeproj'), { recursive: true })
  await mkdir(join(root, 'Packages', 'Kit', 'Example.xcodeproj'), { recursive: true })
  return root
}

function hostFor(root: string, extra: Record<string, unknown> = {}) {
  return mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'ws-1', branch: 'feature/x', displayName: 'bill-customer', terminals: [] },
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'bill-customer', path: root, branch: 'feature/x', hostId: 'local' }],
        truncated: false
      },
      ...extra
    }
  })
}

test('finds the workspace beside the project and skips Pods', async () => {
  const root = await fakeWorktree()
  try {
    const host = hostFor(root)
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    const s = await worker.request('state.get')
    assert.equal(s.workspace?.path, root)
    assert.deepEqual(s.projects.map((p) => p.label), ['App.xcworkspace', 'App.xcodeproj', 'Packages/Kit/Example.xcodeproj'])
    assert.equal(s.config.project, join(root, 'App.xcworkspace'))
    assert.equal(s.config.configuration, 'Debug')
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config is kept per worktree and changing project drops the scheme', async () => {
  const root = await fakeWorktree()
  try {
    const host = hostFor(root)
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await worker.request('state.get')
    await worker.request('config.update', { scheme: 'App', configuration: 'Release' })
    let s = await worker.request('config.update', {
      destination: { platform: 'ios', kind: 'device', udid: 'U2', name: 'Wifi iPhone' }
    })
    assert.equal(s.config.scheme, 'App')
    assert.equal(s.config.destination?.name, 'Wifi iPhone')
    s = await worker.request('config.update', { project: join(root, 'App.xcodeproj') })
    assert.equal(s.config.scheme, undefined)
    assert.equal(s.config.configuration, 'Release')
    assert.ok(Object.keys(host.data().storage).includes(`config:${root}`))
    // The status bar shows the scheme fallback and the destination.
    const last = host.callsOf('statusBar.update').at(-1) as { text: string; visible: boolean }
    assert.equal(last.visible, true)
    assert.match(last.text, /Wifi iPhone/)
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hides the status bar item when the worktree has no Xcode project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-empty-'))
  try {
    const host = hostFor(root)
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await worker.emit('workspace.changed', {
      context: { workspaceId: 'ws-1', branch: 'main', displayName: 'web', terminals: [] }
    })
    const last = host.callsOf('statusBar.update').at(-1) as { visible: boolean }
    assert.equal(last.visible, false)
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
