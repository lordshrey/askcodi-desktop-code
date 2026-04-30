/**
 * Algorithm registry. Add new algorithms here and they show up everywhere
 * automatically — CLI flag validation, --help output, harness dispatch.
 *
 * Each entry implements the SwarmAlgorithm interface from `algorithm.ts`.
 */
import { abcAlgorithm } from "./abc"
import { acoAlgorithm } from "./aco"
import { acoFrontierAlgorithm } from "./aco-frontier"
import { acoRouterAlgorithm } from "./aco-router"
import { consensusAlgorithm } from "./consensus"
import { frontierAlgorithm } from "./frontier"
import { noneAlgorithm } from "./none"
import type { SwarmAlgorithm } from "./algorithm"

const ALGORITHMS: SwarmAlgorithm[] = [
  noneAlgorithm,
  acoAlgorithm,
  abcAlgorithm,
  consensusAlgorithm,
  frontierAlgorithm,
  acoFrontierAlgorithm,
  acoRouterAlgorithm,
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
