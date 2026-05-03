// Adapter boot. Imported once from the main process startup path so built-in adapters
// register before any heartbeat service runs.
//
// Add new built-in adapters by writing them under ./{type}/index.ts and registering here.
// External adapters (Phase 6+) load asynchronously from ~/.askcodi/adapter-plugins/.

import { register } from "./registry"
import { claudeCodeAdapter } from "./claude-code"
import { codexAdapter } from "./codex"

let registered = false

export function registerBuiltinAdapters(): void {
  if (registered) return
  register(claudeCodeAdapter, { builtin: true })
  register(codexAdapter, { builtin: true })
  registered = true
}

export {
  register,
  unregister,
  get,
  tryGet,
  list,
  listEnabled,
  onChange,
  setOverridePaused,
} from "./registry"

export { claudeCodeAdapter } from "./claude-code"
export { codexAdapter } from "./codex"
