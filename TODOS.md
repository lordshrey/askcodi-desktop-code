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
