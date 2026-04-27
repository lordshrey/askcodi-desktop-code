/**
 * Algorithm registry. Add new algorithms here and they show up everywhere
 * automatically — CLI flag validation, --help output, harness dispatch.
 *
 * Each entry implements the SwarmAlgorithm interface from `algorithm.ts`.
 */
import { acoAlgorithm } from "./aco"
import { noneAlgorithm } from "./none"
import type { SwarmAlgorithm } from "./algorithm"

const ALGORITHMS: SwarmAlgorithm[] = [
  noneAlgorithm,
  acoAlgorithm,
  // Future: abcAlgorithm, consensusAlgorithm, handoffAlgorithm, ...
]

const BY_NAME: Record<string, SwarmAlgorithm> = Object.fromEntries(
  ALGORITHMS.map((a) => [a.name, a]),
)

export function getAlgorithm(name: string): SwarmAlgorithm | undefined {
  return BY_NAME[name]
}

export function listAlgorithms(): SwarmAlgorithm[] {
  return [...ALGORITHMS]
}

export function algorithmNames(): string[] {
  return ALGORITHMS.map((a) => a.name)
}
