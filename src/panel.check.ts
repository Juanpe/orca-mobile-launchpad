// `orca plugin check` renders the panel per scenario with the real worker on a stand-in host.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  noWorkspace: { results: { 'workspace.readContext': null } }
})
