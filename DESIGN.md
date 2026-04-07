# Design System — AskCodi Desktop

## Product Context
- **What this is:** AI-powered code assistant desktop app. Chat-based interface for interacting with Claude, Codex, and other LLMs to write, debug, and understand code.
- **Who it's for:** Developers who want a local-first AI pair programmer with project-scoped context.
- **Space/industry:** AI coding tools (Cursor, Warp, Windsurf)
- **Project type:** Electron desktop app (dark-first, data-dense, task-focused)

## Aesthetic Direction
- **Direction:** Warm, approachable, brand-aligned with askcodi.com
- **Decoration level:** Minimal. Typography, spacing, and the green/gold palette do the work. No gradients on surfaces, no decorative blobs.
- **Mood:** Professional coding workspace that feels human and conversational. Not cold like Warp, not flashy like Windsurf. Friendly but serious.
- **Reference:** askcodi.com (primary brand reference)

## Typography
- **Display/Headings:** Sora (700) — Geometric, bold, the AskCodi voice. Used for page titles, section headings, sidebar labels, project names. Letter-spacing: -0.03em to -0.04em.
- **Body:** Plus Jakarta Sans (400/500/600) — Clean, highly readable at small sizes. Used for chat messages, descriptions, form labels, buttons. Line-height: 1.7 for body text.
- **UI/Labels:** Plus Jakarta Sans (600) — Same as body but semibold for navigation items, tab labels, and interactive text.
- **Data/Tables:** Plus Jakarta Sans with `font-variant-numeric: tabular-nums` for aligned numbers.
- **Code:** Geist Mono (400) — Clean monospace that pairs well with the proportional fonts. Used for inline code, terminal output, file paths.
- **Loading:** Google Fonts: `family=Sora:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700`
- **Scale:**
  - Display: 36px / Sora 700 / -0.04em
  - H1: 24px / Sora 700 / -0.03em
  - H2: 20px / Sora 600 / -0.02em
  - H3: 16px / Sora 600 / -0.01em
  - Body: 14px / Plus Jakarta Sans 400
  - UI: 13px / Plus Jakarta Sans 600
  - Code: 13px / Geist Mono 400
  - Caption: 12px / Plus Jakarta Sans 400
  - Micro: 11px / Plus Jakarta Sans 600 (badges, timestamps, labels)

## Color

### Approach: Balanced
Primary green for actions and active states. Gold for highlights and upgrades. The brand spectrum (pink, purple, blue, orange, lime) is available for feature categories and visual variety but used sparingly in the desktop app.

### Dark Mode (default)
- **Background:** #1A1D23 (warm blue-gray, not pure black)
- **Deep BG:** #14161B (sidebar, panels, input backgrounds)
- **Surface:** #2F3436 (cards, elevated elements, project selector)
- **Surface Hover:** #383B3D
- **Border:** #444444
- **Border Subtle:** #333333
- **Text Primary:** #E5E5E5
- **Text Secondary:** #A0A0A0
- **Text Muted:** #666666

### Light Mode
- **Background:** #FFFFFF
- **Deep BG:** #F5F5F7
- **Surface:** #F0F0F2
- **Surface Hover:** #E8E8EA
- **Border:** #D4D4D4
- **Border Subtle:** #E0E0E0
- **Text Primary:** #1A1D23
- **Text Secondary:** #555555
- **Text Muted:** #888888

### Brand Colors
- **Primary:** #73CFA8 (minty green — actions, active states, CTA buttons, active tabs)
- **Primary Hover:** #5EC298
- **Primary Subtle:** rgba(115, 207, 168, 0.12) (selected sidebar items, focus rings)
- **Primary On:** #0A0A0A (text on primary backgrounds, dark mode) / #FFFFFF (light mode)
- **Accent:** #FFDC79 (warm gold — plan mode, upgrades, highlights)
- **Accent Subtle:** rgba(255, 220, 121, 0.12)

### Brand Spectrum (use sparingly for categories)
- Pink: #FFB1EE
- Purple: #8F9AFF
- Blue: #5E9BFF
- Orange: #FF8E59
- Lime: #DAEF68

### Semantic Colors
- **Success:** #73CFA8 (same as primary — exit code 0, build passed)
- **Warning:** #FFDC79 (same as accent — rate limits, pending approval)
- **Error:** #FF6B6B (failures, crashes, auth errors)
- **Info:** #5E9BFF (plan mode notices, informational banners)

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable
- **Scale:** 2xs(2px) xs(4px) sm(8px) md(16px) lg(24px) xl(32px) 2xl(48px) 3xl(64px)
- **Component padding:**
  - Buttons: 8px 16px
  - Inputs: 8px 12px
  - Sidebar items: 9px 12px
  - Cards/panels: 16px
  - Section gaps: 24px
  - Page padding: 24px-32px

## Layout
- **Approach:** Grid-disciplined
- **Structure:** Three-zone (sidebar 220px + content flex + optional right panel)
- **Max content width:** 640px for chat messages (readability)
- **Sidebar:** 160-300px resizable, 220px default
- **Border radius:**
  - sm: 6px (inputs, small buttons, badges)
  - md: 8px (cards, panels, tool results, alerts)
  - lg: 12px (dialogs, modals, main mockup container)
  - full: 9999px (pills, avatars, status dots)

## Motion
- **Approach:** Minimal-functional
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(100ms) short(150ms) medium(250ms)
- **Rules:**
  - Hover states: 150ms ease
  - Sidebar toggle: 200ms ease-out
  - Dialog enter: 250ms ease-out (scale 0.95 to 1 + fade)
  - Dialog exit: 150ms ease-in
  - No entrance animations for message content
  - No scroll-driven effects

## Icon Policy
- **Primary library:** Lucide React (consolidate to this)
- **Custom SVGs:** Only for brand-specific icons (AskCodi logo, provider logos)
- **Rules:**
  - All icons use `currentColor` for fill/stroke (never hardcoded colors)
  - Icon size: 16px default, 14px compact, 20px prominent
  - Status dots: 6-7px circles using semantic colors

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-05 | Align desktop with askcodi.com brand | Desktop used #0034FF blue + system fonts, website uses #73CFA8 green + Sora/Plus Jakarta Sans. Unified to match the public brand. |
| 2026-04-05 | Sora for headings, Plus Jakarta Sans for body | Matches website. Sora gives geometric personality. Plus Jakarta Sans is highly readable for chat. |
| 2026-04-05 | Geist Mono for code | Clean monospace that pairs well with Plus Jakarta Sans. Not overused in competitor space. |
| 2026-04-05 | Warm blue-gray backgrounds (#1A1D23) | Pure black (#0A0A0A) is colder than the website's aesthetic. Warm dark grounds the friendly brand. |
| 2026-04-05 | Lucide as primary icon library | Consolidate from 3 libraries (custom + Radix + Lucide) to 1. Custom only for brand icons. |
| 2026-04-05 | 8px default border radius | Matches website's 0.5rem. Slightly rounder than typical IDE, friendlier. |
