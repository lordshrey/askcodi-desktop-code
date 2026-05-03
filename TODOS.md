# TODOS

Deferred work flagged during the OAuth-only-gate + multi-provider-connect refactor. Each item below was reviewed and consciously deferred — not forgotten. See PR description and `/plan-eng-review` output for context.

## Dangling gateway-key cleanup sweep

**What:** Nightly job that deletes rows in `workspace_api_tokens` whose `name` matches `Desktop session - %` and have no associated active row in `desktop_sessions`. Runs in the askcodi-api-app side.

**Why:** `exchange.js` issues the gateway key BEFORE signing the JWT and inserting the refresh-session row. If JWT signing or the session insert fails, the desktop app never receives the key, but the row remains in the DB. Probability is low (sign rarely fails post-deploy, session insert rarely fails after a successful key insert) but accumulating orphans over time is sloppy.

**Where to put it:** New file `askcodi-api-app/src/pages/api/cron/sweep-dangling-desktop-keys.js` invoked by Vercel Cron. Or a Supabase scheduled function — pick whichever pattern the rest of the project uses.

**Acceptance:** running the sweep against a DB with N orphan keys (no matching active session within 7 days) deletes them all and logs the count.

---

## Multi-window logout state propagation

**What:** When `AuthManager.logout()` runs in one window, broadcast to `windowManager.getAll()` so every other window re-evaluates auth and bounces to the login page. Today, window B can stay logged in after window A logs out until it's reloaded.

**Why:** Most users have one window open, so this is rarely hit. But a user who opens a second window then logs out from the first sees the dashboard in window B until they manually close it. Inconsistent and easy to misread as a bug.

**How:** Add `windowManager.broadcastAuthChange()` invoked from `auth-manager.ts::logout()`. Each window's preload listens for `auth:state-changed` and triggers a `window.location.reload()`. Estimated 30–50 LOC.

**Where:** `src/main/auth-manager.ts`, `src/main/windows/main.ts`, `src/main/windows/window-manager.ts`, `src/preload/index.ts`.

---

## Playwright-electron E2E harness for first-launch OAuth + provider flows

**What:** Standalone PR adding `@playwright/test` with the Electron driver. Smoke tests for the five flows in `~/.gstack/projects/lordshrey-askcodi-desktop-code/...-eng-review-test-plan-...md`:

1. Fresh install → OAuth → AskCodi auto-connected → continue → dashboard.
2. Fresh install → OAuth → connect Claude → continue → dashboard.
3. Returning user with valid token → straight to dashboard.
4. Returning user with expired-but-refreshable token → silent refresh → dashboard.
5. Returning user with revoked refresh token → forced re-OAuth.

**Why:** Manual QA misses regressions. First-launch is the most critical flow and currently has zero automated coverage. The unit-level regression tests in `auth-manager.test.ts` guard mechanics but not user journeys.

**Effort:** ~1 day human / ~1 hour CC. Worth it because it pays back on every future auth-related PR.

**Where:** Standalone new directory `e2e/` at repo root. Add to package.json: `"test:e2e": "playwright test"`.

---

## Deep-link race verification on macOS clean install

**What:** Verify behavior when a user clicks an `askcodi://auth?code=…` deep link on macOS BEFORE the app has been launched at least once. macOS Launch Services may not have registered the protocol handler yet.

**Why:** `src/main/index.ts:636` registers `open-url` inside `whenReady()`. If macOS fires `open-url` before the AuthManager is initialized, the auth code may be dropped. CLAUDE.md already notes "OAuth deep link not working: macOS Launch Services may not immediately recognize protocol handlers on first app launch." This TODO is to verify under a clean reinstall and either confirm the existing buffering handles it or add explicit pending-code buffering at module scope.

**How to test:** Follow the "Debugging First Install Issues" recipe in CLAUDE.md (`rm -rf ~/Library/Application Support/Agents Dev/`, reset Launch Services, then trigger OAuth).

**Mitigation if reproduced:** module-level `pendingAuthCodes: string[]` array, flushed by `initAuthManager()`. ~20 LOC.

---

## Sunset legacy `ak-` key UI in `/api_keys` page (web app)

**What:** Once all desktop users are on the new OAuth flow (post a few release cycles), audit whether the existing `/api_keys` page in askcodi-api-app still needs to expose key creation to end users. Desktop sessions auto-mint their own keys; the page is mostly relevant for users who want a key to script the API directly.

**Why:** Probably keep it for power users / SDK use cases, but worth a UX pass to surface "Desktop session" keys differently from user-created keys.

**Where:** `askcodi-api-app/src/pages/api_keys.js`, `askcodi-api-app/src/views/logs/components/logs-table.js` (key name display).

---

## Orchestrator: Electron-aware test infrastructure

**What:** Wire vitest (or equivalent) so DB-touching tests can run against the real `better-sqlite3` binary that the postinstall script rebuilds against Electron's Node ABI. Today, standalone vitest fails with `NODE_MODULE_VERSION 140 vs 127` because the binary is rebuilt for Electron, not for the test runner's Node.

**Why:** `src/main/services/__tests__/issues-checkout.test.ts` is currently `describe.skip()` — the test code is correct and proves the most important orchestrator invariant (atomic checkout race), but it can't execute without Electron's binary. Each phase of the orchestrator adds more DB-touching service tests; we'll keep skipping unless this is fixed.

**Options:**
- A) `electron-mocha` or `vitest-electron-runner` — runs vitest under Electron's Node.
- B) `playwright-electron` — heavier but also unlocks E2E flows.
- C) Dual-build script: rebuild for Node before tests, rebuild for Electron after. Flaky in CI.

**Acceptance:** `bun run test src/main/services/__tests__/issues-checkout.test.ts` runs the 4 atomic-checkout tests and they pass.

**Where:** `vitest.config.ts`, `package.json` scripts, possibly a new `tests/setup-electron.ts`.

---

## Orchestrator: chat → issue backfill (Phase 1.5)

**What:** Migration that adds `issue_id` column to `chats`, then for each existing chat creates one `issues` row (status `in_progress` if not archived else `cancelled`) and links the chat. Worktree fields move to the issue. The chat row stays as the transcript view of that issue's first run.

**Why:** Existing user chats predate the orchestrator. To deliver Decision 4 from `paperclip-orchestrator-plan.md` (chats become children of issues), we need a one-time backfill. Deferred until the orchestrator works end-to-end so we don't migrate user data into something not yet validated.

**Acceptance:** every existing chat has a non-null `issue_id` after migration; opening any old chat in the UI still renders the transcript correctly; rolling the migration back restores the old state cleanly.

**Where:** new `drizzle/00XX_chat_issue_backfill.sql` plus a TS post-migration step in `src/main/lib/db/index.ts` to populate `issues` rows (pure SQL is awkward for the per-chat insert + update join).

---

## Orchestrator: issue detail view

**What:** Build `src/renderer/features/orchestrator/issue-detail-view.tsx`. When the user clicks an issue in the list, slide it in from the right (or replace main content) showing: full description, comments thread, run history with status badges, plan document tab, work products tab, blockers list. Selection state is already in `selectedIssueIdAtom`.

**Why:** Issue list works, runs execute, but you can't drill into an individual issue to see what happened, comment, or update the description. Without this the orchestrator's loop feels incomplete.

**Where:** `src/renderer/features/orchestrator/`. Bind to `trpc.issues.get.useQuery` which already returns issue + comments + blockers + runs + documents in one shot.

**Acceptance:** clicking ISS-N opens a detail panel; comments add live; clicking a run opens a sub-panel with its event stream.

---

## Orchestrator: run live tail

**What:** Real-time streaming of run events into the UI. Today the run-store writes events to `agent_run_events` and the bulk log file, but there's no push channel — UI sees changes only on `refetchInterval` poll.

**Why:** When an agent is running, the user wants to watch chunks land as they're produced. Polling at 5s is acceptable for status changes but feels broken for log content.

**Options:**
- A) tRPC subscription (preferred — already wired in this stack via SSE).
- B) Tighten the poll to 500ms and accept extra DB pressure.

**Acceptance:** clicking on a running run opens a console view that updates within 200ms of each `appendRunLog()` call.

**Where:** new `src/main/lib/trpc/routers/agent-runs.ts` `subscribeEvents` procedure + `RunLiveTail.tsx` consumer.

---

## Orchestrator: chat → issue backfill (Phase 1.5)

**What:** Migration that adds `issue_id` column to `chats`, then for each existing chat creates one `issues` row (status `in_progress` if not archived else `cancelled`) and links the chat. Worktree fields move to the issue. The chat row stays as the transcript view of that issue's first run.

**Why:** Existing user chats predate the orchestrator. To deliver Decision 4 from `paperclip-orchestrator-plan.md` (chats become children of issues), we need a one-time backfill. Deferred until the orchestrator works end-to-end so we don't migrate user data into something not yet validated.

**Acceptance:** every existing chat has a non-null `issue_id` after migration; opening any old chat in the UI still renders the transcript correctly; rolling the migration back restores the old state cleanly.

**Where:** new `drizzle/00XX_chat_issue_backfill.sql` plus a TS post-migration step in `src/main/lib/db/index.ts` to populate `issues` rows (pure SQL is awkward for the per-chat insert + update join).
