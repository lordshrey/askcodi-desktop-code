import * as fs from "node:fs/promises"
import * as path from "node:path"
import { eq, and } from "drizzle-orm"
import {
  getDatabase,
  runtimeAgents,
  agentRuntimeState,
  projects,
  type RuntimeAgent,
  type NewRuntimeAgent,
} from "../db"
import { logActivity } from "../services/activity-log"
import { createIssue } from "../services/issues"
import type { AdapterType } from "../../../shared/types/adapter"

// Founding Engineer hire flow.
//
// Auto-hired on first project load. Idempotent — second call returns the existing
// row. Cannot be terminated (terminate guard lives in runtime-agents router).
//
// Permissions: { canCreateAgents: true } so they can call askcodi__hireAgent
// and assemble their team.

const FOUNDING_ENGINEER_DEFAULTS = {
  name: "Founding Engineer",
  role: "founding_engineer",
  title: "Founding Engineer",
  icon: "FE",
  adapterType: "claude_code" as AdapterType,
  adapterConfig: { model: "claude-sonnet-4-5", mode: "agent", maxTurns: 50 },
  autonomyMode: "event" as const,
  permissions: { canCreateAgents: true, canHireFromTemplate: true } as Record<
    string,
    unknown
  >,
}

let cachedSystemPrompt: string | null = null

/**
 * Returns the founding engineer system prompt loaded from the bundled template.
 * Cached after first read.
 */
export async function loadFoundingEngineerSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt
  // Resolve from this file's location. In dev: src/main/lib/agents/_templates/.
  // After electron-vite bundle: out/main/_templates/ (we copy via vite config).
  const candidates = [
    path.join(__dirname, "_templates", "founding-engineer.md"),
    path.join(__dirname, "..", "agents", "_templates", "founding-engineer.md"),
    path.join(process.cwd(), "src", "main", "lib", "agents", "_templates", "founding-engineer.md"),
  ]
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf8")
      cachedSystemPrompt = content
      return content
    } catch {
      // try next
    }
  }
  // Fallback: a minimal embedded prompt so the agent still works in packaged builds
  // even if the template file isn't bundled. Logged because silent fallback to a
  // 12-word prompt is much worse than the agent feeling slightly off.
  // eslint-disable-next-line no-console
  console.error(
    "[founding-engineer] template not found at any candidate path; using minimal fallback prompt",
    { tried: candidates },
  )
  cachedSystemPrompt = "You are the Founding Engineer. Hire help, delegate via issues, ship."
  return cachedSystemPrompt
}

/**
 * Idempotently ensure a founding engineer exists for the given project.
 * Returns the (existing or newly created) agent. Never throws on the happy path.
 */
export async function ensureFoundingEngineer(projectId: string): Promise<RuntimeAgent> {
  const db = getDatabase()

  // Fast path: already exists.
  const existing = db
    .select()
    .from(runtimeAgents)
    .where(
      and(
        eq(runtimeAgents.defaultProjectId, projectId),
        eq(runtimeAgents.isFounding, true),
      ),
    )
    .get()
  if (existing) return existing

  // Hire fresh.
  const row: NewRuntimeAgent = {
    name: FOUNDING_ENGINEER_DEFAULTS.name,
    role: FOUNDING_ENGINEER_DEFAULTS.role,
    title: FOUNDING_ENGINEER_DEFAULTS.title,
    icon: FOUNDING_ENGINEER_DEFAULTS.icon,
    adapterType: FOUNDING_ENGINEER_DEFAULTS.adapterType,
    adapterConfig: FOUNDING_ENGINEER_DEFAULTS.adapterConfig,
    isFounding: true,
    defaultProjectId: projectId,
    autonomyMode: FOUNDING_ENGINEER_DEFAULTS.autonomyMode,
    permissions: FOUNDING_ENGINEER_DEFAULTS.permissions,
    status: "idle",
    reportsTo: null,
  }
  let inserted: RuntimeAgent
  try {
    inserted = db.insert(runtimeAgents).values(row).returning().all()[0]
  } catch (error) {
    // Lost a race against another caller — partial unique index rejected the second insert.
    // Re-read and return the winner.
    const winner = db
      .select()
      .from(runtimeAgents)
      .where(
        and(
          eq(runtimeAgents.defaultProjectId, projectId),
          eq(runtimeAgents.isFounding, true),
        ),
      )
      .get()
    if (winner) return winner
    throw error
  }

  // Initialize runtime state row so cumulative counters increment cleanly.
  db
    .insert(agentRuntimeState)
    .values({ runtimeAgentId: inserted.id, adapterType: inserted.adapterType })
    .onConflictDoNothing()
    .run()

  await logActivity({
    actorType: "system",
    actorId: "auto_hire",
    action: "runtime_agent.founding_engineer_hired",
    entityType: "runtime_agent",
    entityId: inserted.id,
    runtimeAgentId: inserted.id,
    details: { projectId },
  })

  // First mission: give the founding engineer something concrete to do so opening
  // the orchestrator with a fresh project doesn't feel like an empty room. We
  // create the issue but don't auto-wake — the user clicks Run when they're ready.
  try {
    await createFirstMissionIssue(projectId, inserted.id)
  } catch (error) {
    // Non-fatal — the agent still exists, the user can create their own first issue.
    // eslint-disable-next-line no-console
    console.error("[founding-engineer] first-mission issue create failed:", error)
  }

  return inserted
}

async function createFirstMissionIssue(
  projectId: string,
  foundingAgentId: string,
): Promise<void> {
  const db = getDatabase()
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  const projectName = project?.name ?? "this project"
  await createIssue({
    projectId,
    title: `Get oriented in ${projectName}`,
    description: [
      `This is your first run on ${projectName}. Start by understanding what's here:`,
      "",
      "1. Read the project README and any architecture / contributor docs.",
      "2. Run `Glob` and `Read` to map the codebase structure.",
      "3. Open package.json (or equivalent) — note scripts, dependencies, and how to run / test.",
      "4. Use `askcodi__upsertIssueDocument(key=\"plan\")` to write down what you learned and what",
      "   you'd recommend tackling first. The user reads that document in the UI.",
      "5. If the work splits naturally, hire specialists with `askcodi__hireAgent` and create",
      "   sub-issues with `askcodi__createIssue`. If it's small enough to do yourself, just do it.",
      "",
      "When you're done, mark this issue done and propose the next move.",
    ].join("\n"),
    priority: "high",
    status: "todo",
    assigneeRuntimeAgentId: foundingAgentId,
    originKind: "auto_hire" as const,
    actor: { type: "system" as const, id: "founding_engineer_first_mission" },
  })
}

/**
 * Returns true if this agent is the founding engineer (cannot be terminated, has
 * canCreateAgents by default).
 */
export function isFoundingEngineer(agent: Pick<RuntimeAgent, "isFounding">): boolean {
  return agent.isFounding === true
}
