import type {
  AdapterType,
  DesktopAdapter,
} from "../../../shared/types/adapter"

// Mutable in-process registry of adapters.
// Built-in adapters register at boot in ./index.ts. External adapters (Phase 6+) register
// after dynamic import from ~/.askcodi/adapter-plugins/ — that pathway is not yet built.
//
// Lookup contract:
//   - get(type) returns the registered adapter or throws if missing.
//   - tryGet(type) returns null instead of throwing, for optional callsites.
//   - list() returns a snapshot — array, not the live map.
//
// Override semantics (paperclip pattern, deferred to Phase 6):
//   When an external adapter registers with the same type as a built-in, the built-in
//   is preserved in `builtinFallbacks` so setOverridePaused() can restore it without
//   re-registering. For MVP we just allow last-write-wins via register().
const adapters = new Map<AdapterType, DesktopAdapter>()
const builtinFallbacks = new Map<AdapterType, DesktopAdapter>()

const changeListeners = new Set<() => void>()

function notifyChange(): void {
  for (const listener of changeListeners) {
    try {
      listener()
    } catch {
      // listener failures must not break the registry
    }
  }
}

export function register(adapter: DesktopAdapter, options?: { builtin?: boolean }): void {
  if (options?.builtin && !builtinFallbacks.has(adapter.type)) {
    builtinFallbacks.set(adapter.type, adapter)
  }
  adapters.set(adapter.type, adapter)
  notifyChange()
}

export function unregister(type: AdapterType): void {
  adapters.delete(type)
  notifyChange()
}

export function setOverridePaused(type: AdapterType, paused: boolean): void {
  if (paused) {
    const builtin = builtinFallbacks.get(type)
    if (builtin) {
      adapters.set(type, builtin)
      notifyChange()
    }
  }
  // resume: no-op for MVP — caller re-registers the override directly
}

export function get(type: AdapterType): DesktopAdapter {
  const found = adapters.get(type)
  if (!found) {
    throw new Error(`No adapter registered for type "${type}". Known: [${list().map((a) => a.type).join(", ")}]`)
  }
  return found
}

export function tryGet(type: AdapterType): DesktopAdapter | null {
  return adapters.get(type) ?? null
}

export function list(): DesktopAdapter[] {
  return Array.from(adapters.values())
}

export function listEnabled(): DesktopAdapter[] {
  // For MVP, all registered adapters are enabled. Phase 6 adds disable/enable per-instance.
  return list()
}

export function onChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function clear(): void {
  adapters.clear()
  builtinFallbacks.clear()
  notifyChange()
}
