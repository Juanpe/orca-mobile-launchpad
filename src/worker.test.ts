// Runs the worker over a mock host and a throwaway worktree folder with an Xcode project in it.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
  await mkdir(join(root, 'ios', 'Widget.xcodeproj'), { recursive: true })
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

test('finds root and ios/ projects, prefers the workspace, ignores other folders', async () => {
  const root = await fakeWorktree()
  try {
    const host = hostFor(root)
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    const s = await worker.request('state.get')
    assert.equal(s.workspace?.path, root)
    assert.deepEqual(s.projects.map((p) => p.label), ['App.xcworkspace', 'App.xcodeproj', 'ios/Widget.xcodeproj'])
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

test('a folder of repositories is not an iOS project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-repos-'))
  await mkdir(join(root, 'SkyStream', 'SkyStream.xcodeproj'), { recursive: true })
  try {
    const worker = await mountWorker(main, { host: hostFor(root), events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    const s = await worker.request('state.get')
    assert.deepEqual(s.projects, [])
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('state stays plain JSON after a run reports its phases', async () => {
  const root = await fakeWorktree()
  try {
    const worker = await mountWorker(main, { host: hostFor(root), events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    const s = await worker.request('config.update', { configuration: 'Release' })
    assert.equal(JSON.stringify(s).includes('undefined'), false)
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed build reports its errors and log tail', async () => {
  const root = await fakeWorktree()
  try {
    const host = hostFor(root, {
      'terminal.create': { terminalId: 't-1' },
      'terminal.list': { terminals: [{ id: 't-1' }], truncated: false }
    })
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await worker.request('config.update', {
      scheme: 'App',
      destination: { platform: 'ios', kind: 'simulator', udid: 'SIM', name: 'iPhone 18 Pro' }
    })
    const started = await worker.request('run')
    assert.equal(started.run.phase, 'preparing')
    const logPath = started.run.logPath!
    const statusPath = logPath.replace(/build-(\w+)\.log$/, 'status-$1.txt')
    await writeFile(logPath, '/a/b/Foo.swift:3:1: error: boom\n** BUILD FAILED **\n')
    await writeFile(statusPath, 'failed:Build failed\n')
    // The worker polls the status file once a second.
    await new Promise((resolve) => setTimeout(resolve, 1300))
    const s = await worker.request('state.get')
    assert.equal(s.run.phase, 'failed')
    assert.deepEqual(s.run.errors, ['Foo.swift:3:1: error: boom', '** BUILD FAILED **'])
    assert.match(s.run.logTail ?? '', /BUILD FAILED/)
    assert.ok(host.callsOf('notifications.show').length >= 1)
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a run keeps showing, and the status bar says so, after switching worktree', async () => {
  const root = await fakeWorktree()
  const other = await mkdtemp(join(tmpdir(), 'launchpad-other-'))
  try {
    const host = mockHost({
      results: {
        'workspace.readContext': { workspaceId: 'ws-1', branch: 'feature/x', displayName: 'bill-customer', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'worktree', name: 'bill-customer', path: root, branch: 'feature/x', hostId: 'local' },
            { id: 'ws-2', kind: 'worktree', name: 'web', path: other, branch: 'main', hostId: 'local' }
          ],
          truncated: false
        },
        'terminal.create': { terminalId: 't-1' },
        'terminal.list': { terminals: [{ id: 't-1' }], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await worker.request('config.update', {
      scheme: 'App',
      destination: { platform: 'ios', kind: 'simulator', udid: 'SIM', name: 'iPhone 18 Pro' }
    })
    await worker.request('run')
    await worker.emit('workspace.changed', { context: { workspaceId: 'ws-2', branch: 'main', displayName: 'web', terminals: [] } })
    const s = await worker.request('state.get')
    assert.equal(s.workspace?.name, 'web')
    assert.deepEqual(s.otherRuns.map((o) => [o.workspace.name, o.run.phase]), [['bill-customer', 'preparing']])
    const bar = host.callsOf('statusBar.update').at(-1) as { visible: boolean; text: string }
    assert.equal(bar.visible, true)
    assert.match(bar.text, /1 building elsewhere/)
    await worker.request('stop', { path: root })
    assert.deepEqual((await worker.request('state.get')).otherRuns, [])
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})
