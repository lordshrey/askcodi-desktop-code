# AskCodi Logo & Favicon Replacement Checklist

Replace the old 21st logo SVG/images with AskCodi branding in these locations.

## App Icons (replace image files)

- [ ] `build/icon.png` — Main app icon (1024x1024 PNG)
- [ ] `build/icon.icns` — macOS app icon
- [ ] `build/icon.ico` — Windows app icon
- [ ] `build/trayTemplate.png` — macOS menu bar tray icon (monochrome, "Template" suffix required)
- [ ] `build/trayTemplate.svg` — Tray icon SVG source
- [ ] `build/settingsTemplate.png` — Settings tray icon
- [ ] `build/settingsTemplate@2x.png` — Settings tray icon @2x

## Installer Backgrounds (replace image files)

- [ ] `build/dmg-background.png` — macOS DMG installer background
- [ ] `build/dmg-background@2x.png` — DMG background @2x
- [ ] `build/dmg-background.svg` — DMG background SVG source
- [ ] `build/background.svg` — Installer background
- [ ] `build/background@2x.png` — Installer background @2x

## In-App SVG Logo (replace the `<path d="M358.333...">` with AskCodi SVG path)

- [ ] `src/renderer/components/ui/logo.tsx` — Logo component used throughout the app
- [ ] `src/renderer/index.html` (lines 70-72) — Loading screen SVG shown while app boots
- [ ] `src/renderer/features/agents/ui/agent-preview.tsx` (line ~497) — First loading indicator in preview
- [ ] `src/renderer/features/agents/ui/agent-preview.tsx` (line ~584) — Second loading indicator in preview
