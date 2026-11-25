// Runs the worker over a mock host and a throwaway worktree folder with an Xcode project in it.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
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

// A stand-in for the runner script: stays alive a few seconds and does nothing else.
const fakeRunnerDir = await mkdtemp(join(tmpdir(), 'launchpad-runner-'))
process.env.MOBILE_LAUNCHPAD_RUNNER = join(fakeRunnerDir, 'runner.sh')
await writeFile(process.env.MOBILE_LAUNCHPAD_RUNNER, 'sleep 4\n')
process.env.MOBILE_LAUNCHPAD_WORKDIR = join(fakeRunnerDir, 'work')

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
    assert.ok(bar.text.length <= 64)
    await worker.request('stop', { path: root })
    assert.deepEqual((await worker.request('state.get')).otherRuns, [])
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('closing the run terminal does not stop the build; Terminal opens a new one', async () => {
  const root = await fakeWorktree()
  try {
    let created = 0
    const host = mockHost({
      results: {
        'workspace.readContext': { workspaceId: 'ws-1', branch: 'feature/x', displayName: 'bill-customer', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'bill-customer', path: root, branch: 'feature/x', hostId: 'local' }],
          truncated: false
        },
        'terminal.list': { terminals: [], truncated: false },
        'terminal.focus': { focused: true },
        'terminal.create': () => ({ terminalId: `t-${++created}` })
      }
    })
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await worker.request('config.update', {
      scheme: 'App',
      destination: { platform: 'ios', kind: 'simulator', udid: 'SIM', name: 'iPhone 18 Pro' }
    })
    await worker.request('run')
    // The terminal is gone (terminal.list is empty), yet the run goes on.
    await new Promise((resolve) => setTimeout(resolve, 2200))
    assert.equal((await worker.request('state.get')).run.phase, 'preparing')
    assert.deepEqual(await worker.request('worktree.show', { path: root, terminal: true }), { shown: true })
    assert.equal(created, 2)
    await worker.request('stop', {})
    assert.equal((await worker.request('state.get')).run.phase, 'stopped')
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Runs the `launchpad` command the worker wrote, from `cwd`; answers its output and exit code. */
function launchpad(cwd: string, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [join(process.env.MOBILE_LAUNCHPAD_WORKDIR!, 'launchpad'), ...args], { cwd })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    child.on('close', (code) => resolve({ code, out }))
  })
}

const until = async (check: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('launchpad run reports a failed build with its errors; status and stop work', async () => {
  const root = await fakeWorktree()
  try {
    const host = hostFor(root, { 'terminal.create': { terminalId: 't-1' }, 'terminal.list': { terminals: [{ id: 't-1' }], truncated: false } })
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await worker.request('config.update', {
      scheme: 'App',
      destination: { platform: 'ios', kind: 'simulator', udid: 'SIM', name: 'iPhone 18 Pro' }
    })
    // The worker writes the command and marks itself alive within a second.
    await until(async () => (await readdir(join(process.env.MOBILE_LAUNCHPAD_WORKDIR!, 'requests'))).includes('.alive'))

    const running = launchpad(join(root, 'ios'), 'run')
    await until(async () => (await worker.request('state.get')).run.phase === 'preparing')
    const { logPath } = (await worker.request('state.get')).run
    await writeFile(logPath!, '/a/b/Foo.swift:3:1: error: boom\n** BUILD FAILED **\n')
    await writeFile(logPath!.replace(/build-(\w+)\.log$/, 'status-$1.txt'), 'failed:Build failed\n')
    const result = await running
    assert.equal(result.code, 1, result.out)
    assert.match(result.out, /▸ App \(Debug\) → iPhone 18 Pro {2}\[bill-customer\]/)
    assert.match(result.out, /✗ Build failed/)
    assert.match(result.out, /Foo\.swift:3:1: error: boom/)

    const status = await launchpad(root, 'status')
    assert.equal(status.code, 0, status.out)
    assert.match(status.out, /bill-customer: failed/)

    const again = await launchpad(root, 'run', '--no-wait', '--configuration', 'Release')
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /App \(Release\)/)
    const stop = await launchpad(root, 'stop')
    assert.match(stop.out, /Stopped App in bill-customer/)
    assert.equal((await worker.request('state.get')).run.phase, 'stopped')

    const outside = await launchpad(tmpdir(), 'status')
    assert.equal(outside.code, 1)
    assert.match(outside.out, /not inside an Orca worktree/)
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs survive a worker restart', async () => {
  const root = await fakeWorktree()
  try {
    const results = { 'terminal.create': { terminalId: 't-1' }, 'terminal.list': { terminals: [{ id: 't-1' }], truncated: false } }
    const host = hostFor(root, results)
    const first = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await first.request('config.update', {
      scheme: 'App',
      destination: { platform: 'ios', kind: 'simulator', udid: 'SIM', name: 'iPhone 18 Pro' }
    })
    await first.request('run')
    await new Promise((resolve) => setTimeout(resolve, 200)) // storage writes are queued
    await first.deactivate()
    // A new worker over the same storage (a reinstall) finds the run still going.
    const second = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    await until(async () => (await second.request('state.get')).run.phase === 'preparing', 3000)
    await second.request('stop', {})
    await second.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Adds a Gradle build with an app module and a library module under android/. */
async function addAndroid(root: string): Promise<string> {
  const dir = join(root, 'android')
  await mkdir(join(dir, 'app'), { recursive: true })
  await mkdir(join(dir, 'core'), { recursive: true })
  await writeFile(join(dir, 'settings.gradle.kts'), 'rootProject.name = "Qamarero"\ninclude(":app")\ninclude(":core")\n')
  await writeFile(
    join(dir, 'app/build.gradle.kts'),
    'plugins { alias(libs.plugins.android.application) }\nandroid {\n  buildTypes {\n    release { }\n    create("internal") { }\n  }\n}\n'
  )
  await writeFile(join(dir, 'core/build.gradle.kts'), 'plugins { id("com.android.library") }\n')
  return dir
}

test('a worktree with iOS and Android: switching platform resets variant and destination', async () => {
  const root = await fakeWorktree()
  try {
    const android = await addAndroid(root)
    const host = hostFor(root, { 'terminal.create': { terminalId: 't-1' }, 'terminal.list': { terminals: [{ id: 't-1' }], truncated: false } })
    const worker = await mountWorker(main, { host, events: ['workspace.changed'], commands: ['launchpad.run', 'launchpad.stop'] })
    let s = await worker.request('state.get')
    // iOS projects first; the Gradle build last, named by rootProject.name.
    assert.deepEqual(s.projects.at(-1), { platform: 'android', kind: 'gradle', path: android, label: 'android', name: 'Qamarero' })
    assert.equal(s.projects[0]!.platform, 'ios')
    assert.ok(s.projects.some((p) => p.platform === 'android' && p.path === android))
    await worker.request('config.update', {
      configuration: 'Release',
      destination: { platform: 'ios', kind: 'simulator', udid: 'SIM', name: 'iPhone 18 Pro' }
    })
    s = await worker.request('config.update', { project: android })
    assert.equal(s.config.project, android)
    assert.equal(s.config.configuration, 'debug')
    assert.equal(s.config.destination, undefined)
    const targets = await worker.request('schemes.list', {})
    assert.deepEqual(targets.schemes, [':app', ':core'])
    assert.deepEqual(targets.appSchemes, [':app'])
    assert.deepEqual(targets.configurations, ['debug', 'release', 'internal'])

    await worker.request('config.update', {
      destination: { platform: 'android', kind: 'simulator', udid: 'Pixel_9', name: 'Pixel 9' }
    })
    await until(async () => (await readdir(join(process.env.MOBILE_LAUNCHPAD_WORKDIR!, 'requests'))).includes('.alive'))
    const run = await launchpad(root, 'run', '--android', '--no-wait', '--configuration', 'internal')
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /▸ Qamarero \(internal\) → Pixel 9/)
    s = await worker.request('state.get')
    assert.equal(s.run.phase, 'preparing')
    assert.equal(s.config.scheme, ':app')
    s = await worker.request('stop', {})
    const ios = await launchpad(root, 'status')
    assert.match(ios.out, /stopped/)
    await worker.deactivate()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
