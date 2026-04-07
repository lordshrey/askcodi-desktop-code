import type { ITerminalOptions, ITheme } from "xterm"
import { extractTerminalTheme } from "@/lib/themes/terminal-theme-mapper"

// Nerd Fonts first for shell theme compatibility (Oh My Posh, Powerlevel10k, etc.)
// Geist Mono added for consistency with app font
const TERMINAL_FONT_FAMILY = [
  "Geist Mono",
  "MesloLGM Nerd Font",
  "MesloLGM NF",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  "JetBrainsMono Nerd Font",
  "CaskaydiaCove Nerd Font",
  "Menlo",
  "Monaco",
  '"Courier New"',
  "monospace",
].join(", ")

/**
 * Dark terminal theme synchronized with the app's design system.
 * Colors are based on Tailwind's zinc palette and CSS variables.
 * 
 * Dark theme values (aligned with askcodi.com brand):
 * - --background: #1A1D23 (warm blue-gray)
 * - --foreground: #E5E5E5
 * - --tl-background: #14161B (deep bg)
 * - --primary: #73CFA8 (minty green)
 */
export const TERMINAL_THEME_DARK: ITheme = {
  background: "#14161b",
  foreground: "#e5e5e5",

  cursor: "#e5e5e5",
  cursorAccent: "#14161b",

  selectionBackground: "#444444",
  selectionForeground: "#ffffff",

  black: "#14161b",
  red: "#ff6b6b",
  green: "#73cfa8",          // --primary (brand green)
  yellow: "#ffdc79",         // --accent (brand gold)
  blue: "#5e9bff",           // brand blue
  magenta: "#8f9aff",        // brand purple
  cyan: "#06b6d4",
  white: "#e5e5e5",

  brightBlack: "#666666",
  brightRed: "#ff8080",
  brightGreen: "#8fdcbb",
  brightYellow: "#ffe599",
  brightBlue: "#7db0ff",
  brightMagenta: "#a8b0ff",
  brightCyan: "#22d3ee",
  brightWhite: "#f5f5f5",
}

/**
 * Light terminal theme synchronized with the app's design system.
 * 
 * Light theme values (aligned with askcodi.com brand):
 * - --background: #FFFFFF
 * - --foreground: #1A1D23
 * - --tl-background: #F5F5F7
 * - --primary: #4DAE82 (darker green for light mode)
 */
export const TERMINAL_THEME_LIGHT: ITheme = {
  background: "#f5f5f7",
  foreground: "#1a1d23",

  cursor: "#1a1d23",
  cursorAccent: "#f5f5f7",

  selectionBackground: "#d4d4d4",
  selectionForeground: "#1a1d23",

  black: "#1a1d23",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",           // standard blue
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f5f5f7",

  brightBlack: "#555555",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",     // blue-500
  brightMagenta: "#a855f7",  // purple-500
  brightCyan: "#06b6d4",     // cyan-500
  brightWhite: "#fafafa",    // zinc-50
}

/** @deprecated Use TERMINAL_THEME_DARK instead */
export const TERMINAL_THEME = TERMINAL_THEME_DARK

/**
 * Get terminal theme based on current app theme
 */
export function getTerminalTheme(isDark: boolean): ITheme {
  return isDark ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT
}

/**
 * Get terminal theme from VS Code theme colors
 * Falls back to default themes if colors are not provided
 */
export function getTerminalThemeFromVSCode(
  themeColors: Record<string, string> | null | undefined,
  isDark: boolean,
): ITheme {
  if (!themeColors) {
    return getTerminalTheme(isDark)
  }
  return extractTerminalTheme(themeColors)
}

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  // Font size matches app's compact UI (text-xs = 12px, text-sm = 14px)
  fontSize: 13,
  lineHeight: 1.4,
  fontFamily: TERMINAL_FONT_FAMILY,
  theme: TERMINAL_THEME_DARK, // Default, will be overridden dynamically
  allowProposedApi: true,
  scrollback: 10000,
  macOptionIsMeta: true,
  cursorStyle: "block",
  cursorInactiveStyle: "outline",
  fastScrollModifier: "alt",
  fastScrollSensitivity: 5,
  // Better letter spacing for code readability
  letterSpacing: 0,
}

export const RESIZE_DEBOUNCE_MS = 150
