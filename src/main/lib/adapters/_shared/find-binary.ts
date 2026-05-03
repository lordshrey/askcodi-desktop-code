import * as path from "node:path"
import * as fs from "node:fs/promises"
import { findSystemBinary } from "../../claude/find-binary"

/**
 * Locate an adapter's executable. Order:
 *   1. Bundled binary under `resources/bin/<name>` (shipped via download scripts)
 *   2. Standard system install locations + PATH (via findSystemBinary)
 */
export async function findAdapterBinary(name: string): Promise<string | null> {
  const bundled = path.join(process.cwd(), "resources", "bin", name)
  try {
    const stat = await fs.stat(bundled)
    if (stat.isFile() && (stat.mode & 0o111) !== 0) return bundled
  } catch {
    // not bundled — fall through
  }
  return findSystemBinary(name)
}
