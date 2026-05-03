# Plan: AskCodi Desktop → Agent Orchestrator

Transform `askcodi-desktop-code` from a single-user Claude Code chat app into a paperclip-style multi-agent orchestrator. Single-user (no companies), local-first (SQLite + Electron), but with the full orchestration model: persistent agents with org charts, durable issues with atomic checkout, heartbeat runs with session resume, watchdog recovery, MCP tools for agent self-service.

References: `paperclip-research.md`, `paperclip-internals.md` at the project root.

---

## 1. Goal in one sentence

Turn the desktop app into a system where a user defines a goal, hires persistent agents (CEO, engineers, designers), assigns issues to them, and the agents wake themselves on schedule or on event, check out work atomically, run via the Claude/Codex/Cursor SDKs, resume across heartbeats, and roll up cost — all visible in a kanban + chat hybrid UI.

## 2. Current state

```
src/main/lib/db/schema/index.ts:
  projects     (folder-backed)
  chats        (1 chat = 1 worktree, optional PR/source link)
  sub_chats    (Claude SDK session per sub-chat, mode: plan|agent)
  + auth tables (anthropic_accounts, integrations, claude_code_credentials)

tRPC routers (already exist):
  agents       — reads file-based ~/.claude/agents/*.md prompt files. NOT orchestration.
  tasks        — browses GitHub issues / Linear tickets. NOT native work units.
  chats        — CRUD on chats table.
  claude       — Claude Code SDK invocation (the actual agent runtime today).
  codex        — Codex SDK invocation.
  ollama       — Local model.
  skills, plugins, commands — early-stage extension surfaces.

UI features:
  agents/      — file-agent picker, slash commands, mentions
  chats        — active chat, transcript, tool renderers
  sub-chats    — tabbed sub-conversation panel
  kanban       — kanban view of external (GitHub/Linear) tasks
  tasks        — task list, "work on task" dialog
  onboarding-v2
```

## 3. Target state

```
src/shared/                             ← single source of truth
  types/      Agent, Issue, Run, Workspace, AdapterType...
  validators/ zod schemas
  constants/  enums (AGENT_ROLES, ISSUE_STATUSES, RUN_STATUSES)

src/main/
  lib/db/schema/                        ← one file per table
    projects.ts
    issues.ts                  ← NEW (work units)
    issue_relations.ts         ← NEW (blocks)
    issue_comments.ts          ← NEW
    issue_documents.ts         ← NEW (plan/analysis)
    issue_work_products.ts     ← NEW (PRs created)
    runtime_agents.ts          ← NEW (orchestrated agents — disambiguated name)
    agent_wakeup_requests.ts   ← NEW (queue)
    agent_runs.ts              ← NEW (heartbeat_runs equivalent)
    agent_run_events.ts        ← NEW (log stream)
    agent_task_sessions.ts     ← NEW (resume state)
    agent_runtime_state.ts     ← NEW (cumulative usage)
    cost_events.ts             ← NEW
    activity_log.ts            ← NEW
    chats.ts                   ← migrated to live alongside (transcript view of issue runs)
    sub_chats.ts               ← keep for plan-mode scratchpad
    + existing auth tables

  adapters/                             ← NEW
    types.ts                   DesktopAdapter interface
    registry.ts                mutable register/get/list
    claude-code/               wraps existing Claude SDK code
    claude-api/                Anthropic Messages API
    codex/                     wraps existing Codex SDK
    cursor/                    Phase 2
    ollama/                    wraps existing Ollama integration

  services/                             ← NEW
    heartbeat.ts               wakeup, dispatch, executeRun
    issues.ts                  atomic checkout, dependency readiness
    run-store.ts               event stream + bulk log persistence
    liveness.ts                classifyRunLiveness equivalent
    watchdog.ts                lastOutputAt monitoring
    workspace.ts               git worktree per issue
    activity-log.ts            mutation audit
    cost.ts                    cost_events + budget gates

  mcp-server/                           ← NEW (in-process)
    tools.ts                   askcodiCreateIssue, askcodiCheckoutIssue, ...
    server.ts                  exposes tools to agent JWT-authenticated callers

  lib/trpc/routers/
    issues.ts                  ← NEW (CRUD, checkout, comments, documents)
    runtimeAgents.ts           ← NEW (hire, list, configure)
    runs.ts                    ← NEW (live tail, history, cancel)
    activity.ts                ← NEW (audit feed)
    + existing routers stay; agents/tasks routers RENAMED for clarity

src/renderer/features/
  issues/                      ← NEW (kanban + detail + comments)
  org-chart/                   ← NEW (agent tree view)
  runs/                        ← NEW (live tail, history)
  hire/                        ← NEW (hire agent flow)
  + existing chats/sub-chats stay as conversation surface
```

The mental model:
- `chats` and `sub_chats` stay as **the transcript** UI for what happened during a run.
- `issues` are **the work units**. Every chat is now scoped to an issue.
- `runtime_agents` are **persistent**. The user hires them once. They wake themselves.

## 4. Key naming decisions to resolve

This is the most important pre-coding step. Get names wrong and refactoring hurts.

| Concept | Paperclip name | Desktop existing name | Recommended target | Why |
|---|---|---|---|---|
| Persistent orchestrated agent | `agents` | `agents` table doesn't exist; router reads files | **`runtime_agents`** | "agents" router already means file-based prompt configs. Don't conflict. |
| File-based agent prompt | (none) | `agents` router scans `.claude/agents/` | **`agent_definitions`** (rename router) | Distinguish runtime agent from prompt file. |
| Work unit | `issues` | none (chats are conversations, tasks are external) | **`issues`** | Direct lift. Avoids "task" which means GitHub/Linear here. |
| External task from GitHub/Linear | (none) | `tasks` router | **`external_tasks`** (rename router) | Or fold into issues with `originKind: github_issue`. |
| Run / heartbeat invocation | `heartbeat_runs` | none (Claude SDK calls are ephemeral) | **`agent_runs`** | "heartbeat" is paperclip jargon; "run" is clear in desktop context. |
| Conversation transcript | (lives in run logs) | `chats` + `sub_chats` | **keep `chats` + `sub_chats`**, link to issue | Existing UX is good. Don't break it. |

**This whole table is decision #1.** I'm recommending the right column. Confirm or override before I touch a file.

## 5. The big architectural decisions

These are the calls that shape the next 3 months. I'll present each with my recommendation; you say yes / no / modify.

### Decision 1 — Single-user model, drop `companyId` everywhere

Recommendation: **yes, drop it.** No multi-tenancy in desktop. Saves ~74 columns and a permission layer.

Trade: if you ever ship a hosted version, you'll have to add it back. ~2 weeks of pain at that point. Worth it.

### Decision 2 — SQLite vs PGlite

Paperclip uses Postgres with `FOR UPDATE` for issue locks. SQLite has no row-level FOR UPDATE.

But: better-sqlite3 is **synchronous**. Every JS statement runs to completion before the next. The atomic-checkout pattern (`UPDATE issues SET assigneeAgentId=? WHERE id=? AND assigneeAgentId IS NULL`) works correctly in SQLite because SQLite serializes writes globally. There's no race window inside the same process.

Recommendation: **stay with SQLite.** It already works, the migration history is in place, electron-builder handles the binary. PGlite is a 2-week port that buys you nothing for single-user.

Trade: if you ever want two Electron processes touching the same DB, you'll need WAL mode + careful transaction discipline. Not a real worry.

### Decision 3 — Issues vs Chats relationship

Three options:

- **A) Chats embedded in issues.** Every chat is a child of an issue. Issue is the work unit; chat is the transcript. New issues without a chat are allowed (e.g., "review this PR" issue that hasn't been worked on yet).
- **B) Chats and issues are peers, linked optionally.** A chat can exist without an issue (free-form conversation), and an issue can have many chats.
- **C) Replace chats with issues entirely.** Migration: every existing chat becomes an issue with status `in_progress`, transcripts move to `agent_run_events`.

Recommendation: **A.** Cleanest mental model. Existing chats migrate to issues with their worktree fields preserved on the issue. `chats` table stays but gets a `issueId` foreign key.

Trade for A: every existing user gets their chat list re-keyed. Migration script needed. ~50 lines.

### Decision 4 — How aggressive on heartbeats?

Paperclip wakes agents on a 30s timer plus event triggers. In a desktop app, a 30s setInterval running constantly burns battery and feels unnecessary when the user is staring at the window.

Three options:

- **A) Full paperclip parity.** 30s timer always running while app is open. Stops when app is in tray.
- **B) Event-driven only.** No timer. Agents wake on user assignment, on @-mention, on schedule (cron-like routines). User-initiated = 99% of wakes.
- **C) Hybrid.** Event-driven by default. Optional "always-on" mode per agent for users who want true autonomy (e.g., "review my inbox every hour").

Recommendation: **C.** Default off matches desktop UX expectations. Per-agent opt-in for autonomy. Saves battery, gives power users the paperclip experience.

Trade for C: extra config surface ("autonomy mode" toggle on agent). ~half a day.

### Decision 5 — Adapter factoring

Existing code has Claude Code SDK and Codex SDK inlined in tRPC routers (`claude.ts`, `codex.ts`). To get paperclip's adapter pattern, need to extract.

Recommendation: **extract incrementally, don't rewrite.** Phase 1 wraps existing code in the `DesktopAdapter` shape without changing behavior. Phase 2 onward, new adapters slot in. Old SDK call sites keep working until renderer is migrated.

Trade: brief period of two code paths (SDK direct call + adapter call). ~3 days.

### Decision 6 — MCP server scope

Paperclip exposes its REST API as MCP tools so Claude Code can call back and create issues, comment, check out, etc. Without this, the orchestration is one-directional (user-driven only).

Recommendation: **build it. Phase 3, after issues + runs land.** Without MCP tools, agents can't delegate to sub-agents and the org chart is decorative. Implementation is mechanical: each tRPC procedure becomes an MCP tool. ~1 week.

Trade: in-process MCP server adds an HTTP listener. Lock to localhost + JWT. Standard.

### Decision 7 — UI: replace or augment?

The existing `kanban-view.tsx` shows GitHub/Linear external tasks. The new issues system needs a kanban too. Three options:

- **A) New issues kanban replaces existing.** External tasks become a different tab.
- **B) Unified kanban shows both, with filter.** Issues + external tasks side by side.
- **C) Issues kanban is separate; existing kanban stays for external task browsing.**

Recommendation: **B.** Unified is better UX — user sees their work whether it originated as a paperclip issue or got pulled in from GitHub. Implementation: column logic stays, card source becomes a union type.

Trade for B: card component needs a discriminated union renderer. Half a day.

## 6. Phased plan

### Phase 0 — Decisions and renames (1 week)

- [ ] User confirms decisions 1-7 above (or overrides).
- [ ] Rename existing `agents` router → `agentDefinitions` everywhere it's referenced (one big find/replace + tRPC client regeneration).
- [ ] Rename existing `tasks` router → `externalTasks` similarly.
- [ ] Lock down `src/shared/` discipline: types and zod validators move there.
- [ ] CI check: `bun run ts:check` blocks merges that re-introduce the old names.

**Done when:** existing app behaves identically, just with new names. No functional change.

### Phase 1 — Schema foundation (1.5 weeks)

- [ ] Create new schema files (one per table) under `src/main/lib/db/schema/`:
  - `runtime_agents.ts`, `issues.ts`, `issue_relations.ts`, `issue_comments.ts`, `issue_documents.ts`, `issue_work_products.ts`, `agent_runs.ts`, `agent_run_events.ts`, `agent_wakeup_requests.ts`, `agent_task_sessions.ts`, `agent_runtime_state.ts`, `cost_events.ts`, `activity_log.ts`.
- [ ] `bun run db:generate` produces a single migration.
- [ ] Migrate existing `chats` to add `issueId` (nullable for old rows; backfill creates one issue per chat).
- [ ] Add migration test: existing data round-trips intact.
- [ ] Type exports flow through `src/shared/` for renderer consumption.

**Done when:** schema is in place, existing app still works, migration round-trips test passes.

### Phase 2 — Adapter layer (1 week)

- [ ] `src/shared/types/adapter.ts` defines `DesktopAdapter` interface (lift verbatim from `paperclip-internals.md` §1.7, drop multi-tenant fields).
- [ ] `src/main/adapters/registry.ts` with `register/get/list`.
- [ ] `src/main/adapters/claude-code/index.ts` wraps existing Claude SDK call (pulled out of `routers/claude.ts`). Implements `execute`, `testEnvironment`, `sessionCodec`, `models`, `detectModel`, `getConfigSchema`.
- [ ] `src/main/adapters/codex/index.ts` same pattern wrapping `routers/codex.ts`.
- [ ] Codecs: claude-code stores `{ sessionId, cwd, mode }`. Codex stores `{ threadId, cwd }`.
- [ ] Adapter unit tests: `testEnvironment()` happy path + missing binary path.

**Done when:** existing `claude.ts` and `codex.ts` tRPC routers internally call the adapters. Behavior unchanged. Renderer untouched.

### Phase 3 — Run lifecycle (2 weeks)

This is the big one. Implements the heartbeat loop.

- [ ] `src/main/services/heartbeat.ts` with `enqueueWakeup`, `startNextQueuedRunForAgent`, `executeRun`. Lift the structure from paperclip; adapt for single-user.
- [ ] In-process `withAgentStartLock` Promise mutex.
- [ ] Pre-flight gate sequence: agent status → budget → autonomy mode → tree hold → execution lock → deps → coalesce.
- [ ] Atomic checkout via compound WHERE in `src/main/services/issues.ts`. Test concurrent checkout race.
- [ ] Three-sink streaming: `agent_run_events` rows + bulk log file in `userData/runs/{runId}.log` (gzipped on completion) + tRPC subscription for live tail.
- [ ] Adapter callbacks (`onLog`, `onMeta`, `onSpawn`) wired to all three sinks.
- [ ] Process group tracking; PGID-based cancellation.
- [ ] On boot: scan `agent_runs` with `status=running`, mark dead-PGID rows as `crashed`.
- [ ] Liveness classifier (`liveness.ts`) — port the regex set, simplify signal mix for desktop.
- [ ] Transient retry with bounded delays (reuse paperclip constants).
- [ ] Cost events written per LLM call (Claude reports cumulative; do delta).
- [ ] `agent_runtime_state` increments on completion.
- [ ] `agent_task_sessions` upsert via codec.

**Done when:** user clicks "Run agent on issue X" → run row goes through queued → running → succeeded, log streams live to UI, second click on same issue resumes the prior session via codec.

### Phase 4 — Issues UI (1.5 weeks)

- [ ] tRPC routers: `issues` (CRUD, checkout, release, children), `runs` (list, get, cancel, subscribeEvents).
- [ ] `src/renderer/features/issues/`:
  - `IssueBoard` — kanban grouped by status. Decision 7B: includes external tasks as a different card variant.
  - `IssueDetail` — title, description, comments, work products, plan document, run history.
  - `IssueComment` — markdown editor with @-mention (existing mentions/ feature).
  - `RunLiveTail` — streams from tRPC subscription.
- [ ] Existing chat UI gets an "Open issue" button that creates an issue from the chat OR jumps to the linked issue.

**Done when:** user can create an issue, assign it to an agent, watch it run, see results, comment, link work products.

### Phase 5 — Org chart & delegation (1 week)

- [ ] `runtime_agents.reportsTo` with cycle prevention (lift from `agents.ts:290-300`).
- [ ] `issues.parentId` with optional auto-blocker (`createChild` returns `parentBlockerAdded`).
- [ ] On child terminal status, wake the parent's assignee with `reason: "child_completed"` and child summaries.
- [ ] Hire flow: `POST /api/agents/hire` with optional approval prompt to user (the user is the "board" — single-user).
- [ ] `src/renderer/features/org-chart/` — tree view of agents, drag-to-reparent, hire button.

**Done when:** CEO agent can run, create a child issue assigned to engineer agent, engineer wakes and runs, completion wakes CEO with result.

### Phase 6 — MCP server (1 week)

- [ ] In-process MCP server bound to `127.0.0.1:random`, JWT-authenticated.
- [ ] Tools: `askcodiCreateIssue`, `askcodiUpdateIssue`, `askcodiCheckoutIssue`, `askcodiAddComment`, `askcodiUpsertIssueDocument`, `askcodiCreateWorkProduct`, `askcodiListIssues`, `askcodiCreateAgent` (with hire approval).
- [ ] Each tool maps to a tRPC procedure, wrapping it with auth.
- [ ] On run start, mint short-lived JWT with `{ sub: agentId, run_id, exp: +1h }`. Pass to spawned process via env (`ASKCODI_API_TOKEN`).
- [ ] Adapter authenticates inbound MCP calls; activity_log records as that agent.

**Done when:** an agent running Claude Code can call `mcp__askcodi__createIssue` and the issue appears in the user's board.

### Phase 7 — Watchdog, recovery, polish (1 week)

- [ ] Watchdog loop: every 60s, scan running runs whose `lastOutputAt` is stale (>1h warn, >4h kill).
- [ ] `agent_run_watchdog_decisions` table.
- [ ] Onboarding wizard adapted for orchestrator: pick adapter → configure → hire CEO agent → seed first goal/issue.
- [ ] Boot-time recovery hook in `index.ts`.
- [ ] Activity log feed in UI sidebar.
- [ ] Documentation: `CLAUDE.md` updates, internal architecture doc.

**Done when:** ship.

### Out of scope explicitly

- Multi-user / multi-company.
- External adapter plugin loading from `~/.askcodi/adapter-plugins/`. Defer until built-in adapters stabilize.
- OpenClaw HTTP/webhook gateway.
- Approval workflows beyond hire-approval. (Issue execution policy stays single-stage.)
- Tree holds. Defer until we see runaway agents in practice.
- Routines (cron-triggered issues). Phase 8+.
- Storybook.

## 7. Schema delta — concrete

```typescript
// src/main/lib/db/schema/runtime_agents.ts
export const runtimeAgents = sqliteTable("runtime_agents", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  name: text("name").notNull(),
  role: text("role").notNull().default("general"),    // ceo, engineer, designer, ...
  title: text("title"),
  icon: text("icon"),
  status: text("status").notNull().default("idle"),    // idle, running, paused, terminated, pending_approval
  reportsTo: text("reports_to"),                       // self-reference
  adapterType: text("adapter_type").notNull(),         // claude_code | claude_api | codex | cursor | ollama
  adapterConfig: text("adapter_config", { mode: "json" }).notNull().default("{}"),
  runtimeConfig: text("runtime_config", { mode: "json" }).notNull().default("{}"),
  defaultProjectId: text("default_project_id"),        // pin to a project workspace
  budgetMonthlyCents: integer("budget_monthly_cents"),
  spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
  pauseReason: text("pause_reason"),
  pausedAt: integer("paused_at", { mode: "timestamp" }),
  permissions: text("permissions", { mode: "json" }).notNull().default("{}"),
  autonomyMode: text("autonomy_mode").notNull().default("off"),  // off | event | timer (Decision 4C)
  heartbeatIntervalSec: integer("heartbeat_interval_sec"),
  lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
})

// src/main/lib/db/schema/issues.ts
export const issues = sqliteTable("issues", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  parentId: text("parent_id"),                         // self-reference
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("backlog"),
  priority: text("priority").notNull().default("medium"),
  assigneeRuntimeAgentId: text("assignee_runtime_agent_id"),
  // single-user: no assigneeUserId — the human is the board
  checkoutRunId: text("checkout_run_id"),              // atomic lock
  executionRunId: text("execution_run_id"),
  executionLockedAt: integer("execution_locked_at", { mode: "timestamp" }),
  identifier: text("identifier").notNull().unique(),   // e.g. "ISS-42"
  issueNumber: integer("issue_number").notNull(),
  originKind: text("origin_kind").notNull().default("manual"),   // manual | external_task_link | routine
  originId: text("origin_id"),
  worktreePath: text("worktree_path"),                 // git worktree per issue
  branch: text("branch"),
  baseBranch: text("base_branch"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  hiddenAt: integer("hidden_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("issues_status_idx").on(t.status),
  index("issues_assignee_status_idx").on(t.assigneeRuntimeAgentId, t.status),
  index("issues_parent_idx").on(t.parentId),
])

// src/main/lib/db/schema/agent_runs.ts
export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  runtimeAgentId: text("runtime_agent_id").notNull(),
  invocationSource: text("invocation_source").notNull(),  // timer | assignment | on_demand | automation | system
  triggerDetail: text("trigger_detail"),
  status: text("status").notNull().default("queued"),     // queued | scheduled_retry | running | succeeded | failed | cancelled | timed_out
  wakeupRequestId: text("wakeup_request_id"),
  contextSnapshot: text("context_snapshot", { mode: "json" }).notNull().default("{}"),
  sessionIdBefore: text("session_id_before"),
  sessionIdAfter: text("session_id_after"),
  processPid: integer("process_pid"),
  processGroupId: integer("process_group_id"),
  processStartedAt: integer("process_started_at", { mode: "timestamp" }),
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  scheduledRetryAt: integer("scheduled_retry_at", { mode: "timestamp" }),
  scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
  retryOfRunId: text("retry_of_run_id"),
  continuationAttempt: integer("continuation_attempt").notNull().default(0),
  livenessState: text("liveness_state"),
  livenessReason: text("liveness_reason"),
  lastOutputAt: integer("last_output_at", { mode: "timestamp" }),
  lastOutputSeq: integer("last_output_seq").notNull().default(0),
  logRef: text("log_ref"),
  logBytes: integer("log_bytes"),
  logCompressed: integer("log_compressed", { mode: "boolean" }),
  stdoutExcerpt: text("stdout_excerpt"),
  stderrExcerpt: text("stderr_excerpt"),
  resultJson: text("result_json", { mode: "json" }),
  errorCode: text("error_code"),
  error: text("error"),
  usageJson: text("usage_json", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("agent_runs_agent_status_idx").on(t.runtimeAgentId, t.status),
  index("agent_runs_status_last_output_idx").on(t.status, t.lastOutputAt),
])
```

Other tables follow the same pattern. Total: ~13 new tables. SQLite handles all of this fine.

## 8. Test plan

### What needs ★★★ (edge cases + error paths)

1. **Atomic checkout** — concurrent `checkout()` calls for the same issue. Only one wins. The other gets a clear `conflict` error. Test with two parallel `Promise.all`.
2. **Session resume** — run twice on same issue, verify the second run's adapter receives the prior session params via codec. Test with a fake adapter that records its inputs.
3. **Process group cancel** — spawn a child that itself spawns a child. Cancel via PGID. Verify both descendants die. macOS only initially.
4. **Boot-time recovery** — start a run, kill the Electron process mid-run, restart. Verify the run is marked `crashed` and not stuck in `running` forever.
5. **Cost delta** — run twice on same session with cumulative-token adapter. Verify `cost_events` records delta, not cumulative.

### What needs ★★ (happy path)

6. Hire flow → agent appears in list, status `idle`.
7. Issue create → kanban shows it in `backlog`.
8. Comment with @-mention → assigned agent gets a wakeup row.
9. Child completion → parent wakes with summaries.
10. MCP tool `askcodiCreateIssue` called from inside a run → issue created with correct `createdByRuntimeAgentId`.

### What needs ★ (smoke)

11. Migration round-trip on existing data (Phase 1).
12. tRPC router type checks pass.
13. Adapter `testEnvironment()` returns useful error when binary missing.

### E2E

- **First-run onboarding → hire CEO → assign goal → CEO creates child issue → engineer runs → PR appears as work product.** This is THE smoke test. If this works, the system works.

### Test framework

`vitest run` is the standard (already configured). Add `bun run test` to package.json scripts that runs the full suite. Per-module test files co-located (`src/main/services/heartbeat.test.ts`).

## 9. Failure modes and gates

| Codepath | Realistic failure | Test? | Error handling? | UX surfaces? |
|---|---|---|---|---|
| `enqueueWakeup` | Budget hit mid-queue | yes | yes (skip + activity log) | yes (toast) |
| `executeRun` | Adapter binary deleted between hire and run | yes | yes (run fails, errorCode) | yes (issue panel error) |
| `atomic checkout` | Two agents start simultaneously | **critical** | yes (one wins, other gets 409) | partial — need clear UI message |
| `onLog` callback | DB locked while writing event | no | currently no | **silent fail risk** |
| Session resume | Codec returns null on corrupt jsonb | no | yes (fresh session) | no surface — silent restart |
| Process group cancel | Child not detached, kill leaks PID | no | partial | no |
| Boot recovery | App killed while writing logRef | no | partial — null logRef may break replay | no |

**Critical gaps to plug in Phase 3:**
- `onLog` DB-locked retry/backpressure.
- Process detachment verified via `child.pid !== process.pid` assertion.
- Boot recovery handles partial-write `logRef`.

## 10. Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| 0 — renames | `src/main/lib/trpc/routers/`, `src/renderer/features/agents/`, `src/renderer/features/tasks/` | — |
| 1 — schema | `src/main/lib/db/schema/`, `drizzle/` | 0 |
| 2 — adapters | `src/main/adapters/`, `src/main/lib/trpc/routers/claude.ts`, `codex.ts` | 1 |
| 3 — run lifecycle | `src/main/services/`, `src/shared/` | 1 (not 2 — adapter wraps later) |
| 4 — issues UI | `src/main/lib/trpc/routers/issues.ts`, `src/renderer/features/issues/` | 1 |
| 5 — org chart | `src/main/services/`, `src/renderer/features/org-chart/` | 3, 4 |
| 6 — MCP server | `src/main/mcp-server/`, `src/main/lib/trpc/routers/` | 3 |
| 7 — watchdog/polish | `src/main/services/`, `src/main/index.ts` | 3 |

Lanes:
- Lane A: 0 → 1 → 2 → 3 → 7 (sequential, the spine)
- Lane B: 4 (issues UI) parallelizable with 2 once 1 lands
- Lane C: 5 (org chart) waits for 3 + 4
- Lane D: 6 (MCP) waits for 3

Conflict flag: lanes A-step-3 and B-step-4 both touch `src/main/lib/trpc/routers/`. Coordinate: A owns runtime agent + run routers, B owns issue + comment routers. No file overlap.

## 11. What already exists — reuse aggressively

- `src/main/lib/db/` Drizzle setup, auto-migration, type inference. **Keep.**
- `src/main/lib/trpc/` routers + tRPC client wiring. **Keep, add new routers.**
- `src/main/git/` worktree creation (existing chat worktree code). **Lift into `src/main/services/workspace.ts`.** Issues take over from chats.
- Anthropic OAuth + multi-account (`anthropic_accounts`). **Keep, route through adapter config.**
- Claude SDK and Codex SDK invocation in current routers. **Wrap in adapter layer; don't rewrite.**
- `src/renderer/features/mentions/` for @-mention parsing. **Reuse for issue comments.**
- `src/renderer/features/kanban/` board layout. **Reuse for issue kanban (Decision 7B).**
- Existing onboarding flow. **Augment with adapter selection + hire CEO step.**
- `tasks` router for GitHub/Linear browsing. **Renamed to `externalTasks`; cards link to a paperclip-style issue with `originKind: github_issue`.**

## 12. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Atomic checkout race in SQLite under concurrent writes | medium | high | better-sqlite3 is sync; serializes writes. Test with concurrent `Promise.all`. WAL mode. |
| Session codec drift between adapter SDK versions | medium | medium | codec is a pure function; pin Claude SDK version; codec test verifies round-trip. |
| Process group cancel doesn't reap on Windows | high | medium | initially mac-only; document Windows limitation; phase 8 adds Windows job objects. |
| Migration of existing chats loses user data | low | very high | dry-run script with diff output; backup userData before migration; allow rollback. |
| MCP server JWT leaks via env env-dump | low | high | rotate per-run, expire 1h, scope to runId; never log `process.env`. |
| Cost events double-counted on adapter retry | medium | low (financial) | `cost_events` keyed by `(runId, providerExternalCallId)` unique; idempotent insert. |
| Heartbeat timer drains battery in autonomy mode | medium | medium | Decision 4C — opt-in; visible "running" indicator; pause when on battery <20%. |

## 13. Definition of done

- Onboarding → hire CEO → assign goal "build feature X" → CEO creates child issue → engineer agent runs Claude Code in a worktree → opens PR → work product registered → CEO wakes with result. Visible in UI throughout.
- All paths from §8 tested.
- Migration script runs on real user data (your machine first, beta users second).
- `bun run ts:check` and `bun run test` clean.
- Architecture doc updated.
- The first cost event in `cost_events` table from a real run.

## 14. Effort estimate

Solo with CC: **8-10 weeks** for everything through Phase 7.

| Phase | Solo + CC | Team-of-2 + CC |
|---|---|---|
| 0 — renames | 3 days | 1.5 days |
| 1 — schema | 1.5 weeks | 4 days |
| 2 — adapter layer | 1 week | 3 days |
| 3 — run lifecycle | 2 weeks | 1 week |
| 4 — issues UI | 1.5 weeks | 5 days |
| 5 — org chart | 1 week | 3 days |
| 6 — MCP server | 1 week | 4 days |
| 7 — polish | 1 week | 4 days |
| **Total** | **~9 weeks** | **~5 weeks** |

The big variability is Phase 3. Paperclip's `heartbeat.ts` is 7800 lines for a reason. The desktop equivalent should land at ~2000 because no multi-tenancy and no plugin workers — but expect Phase 3 to slip if you hit a SQLite concurrency surprise.

## 15. The 7 decisions, summarized

Before I touch a file:

| # | Decision | My recommendation | Why |
|---|---|---|---|
| 1 | Renaming convention (`runtime_agents`, `issues`, `agent_runs`, etc.) | Adopt as proposed | Avoids collision with existing `agents`/`tasks` routers |
| 2 | Single-user, drop `companyId` | Yes | Saves columns + permission layer |
| 3 | SQLite vs PGlite | Stay SQLite | Sync writes solve race; existing migrations work |
| 4 | Issues vs chats | Chats embedded in issues (option A) | Cleanest model; chat = transcript view |
| 5 | Heartbeat aggressiveness | Hybrid (option C) | Default off; per-agent autonomy mode opt-in |
| 6 | Adapter factoring | Wrap existing, don't rewrite | Reduces risk; keeps app working during migration |
| 7 | UI: issues kanban | Unified kanban (option B) | One board for paperclip issues + external tasks |

## 16. What I need from you

Read this plan. Tell me:
- Yes / no / modify on each of the 7 decisions.
- Whether 9 weeks is OK or if you need a faster MVP path (which I can produce — Phase 0 + 1 + 2 + 3 + a stripped Phase 4 = 5 weeks, no org chart, no MCP, no watchdog).
- Whether to put this plan in OpenSpec format (`openspec/changes/<slug>/proposal.md` + `tasks.md` + `specs/`) or keep it as one doc.

Once those are answered, I start Phase 0 immediately.
