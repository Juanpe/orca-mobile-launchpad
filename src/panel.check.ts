// `orca plugin check` (and `orca plugin shot . --scenario <name>`) render the panel per scenario
// with the real worker on a stand-in host. `demo` points the worker at fixtures/demo-worktree.
import { defineCheck } from 'orca/testing'

const demo = new URL('../fixtures/demo-worktree', import.meta.url).pathname
const context = { workspaceId: 'ws-demo', branch: 'feature/checkout', displayName: 'bill-customer', terminals: [] }
const workspaces = {
  workspaces: [{ id: 'ws-demo', kind: 'worktree', name: 'bill-customer', path: demo, branch: 'feature/checkout', hostId: 'local' }],
  truncated: false
}

export default defineCheck({
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
