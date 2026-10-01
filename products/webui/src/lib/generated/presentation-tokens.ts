/**
 * GENERATED FILE. DO NOT EDIT BY HAND.
 * Produced by scripts/generate-presentation-tokens.ts from
 * @goodvibes-jev/engine/sdk/platform/presentation, the presentation contract
 * the TUI and agent already render through. See that package's own
 * docstring for the parity-audit provenance.
 *
 * This is a layer SEPARATE from src/styles/tokens.css: tokens.css owns the
 * web UI's own brand palette / layout / motion tokens (an explicitly
 * webui-only, NOT-contract layer, documented at its own top); this file
 * owns only the values the SDK contract actually defines: status glyphs
 * and the state tone-color table.
 *
 * Regenerate: `bun run presentation:generate`.
 * `bun run generated:check` verifies it before every build.
 *
 * Import from src/lib/presentation-bridge.ts for the semantic mapping
 * onto web UI components; import from here directly only if you need the
 * raw contract shape.
 */

export const CONTRACT_GLYPHS = {
  "frame": {
    "topLeft": "┌",
    "topRight": "┐",
    "bottomLeft": "└",
    "bottomRight": "┘",
    "horizontal": "─",
    "vertical": "│",
    "teeLeft": "├",
    "teeRight": "┤",
    "teeTop": "┬",
    "teeBottom": "┴",
    "cross": "┼"
  },
  "surface": {
    "top": "▄",
    "bottom": "▀",
    "cursor": "█",
    "altCursor": "▌"
  },
  "navigation": {
    "selected": "▸",
    "collapsed": "▸",
    "expanded": "▾",
    "up": "↑",
    "down": "↓",
    "moreAbove": "▲",
    "moreBelow": "▼",
    "next": "→",
    "back": "←",
    "pipeSeparator": "│"
  },
  "status": {
    "success": "✓",
    "failure": "✕",
    "pending": "•",
    "active": "●",
    "idle": "◌",
    "info": "○",
    "warn": "⚠",
    "blocked": "⊘",
    "skipped": "◇",
    "review": "◈",
    "retry": "↻",
    "handoff": "⇢",
    "reference": "↗",
    "partial": "◐",
    "dualPane": "◆",
    "star": "★"
  },
  "meter": {
    "filled": "█",
    "medium": "▓",
    "light": "▒",
    "empty": "░",
    "spark": [
      "▁",
      "▂",
      "▃",
      "▄",
      "▅",
      "▆",
      "▇",
      "█"
    ]
  }
} as const;

export const CONTRACT_STATE_GLYPHS = {
  "good": "✓",
  "warn": "⚠",
  "bad": "✕",
  "info": "○"
} as const;

export const CONTRACT_TONE_DARK = {
  "fg": {
    "primary": "#e2e8f0",
    "secondary": "#cbd5e1",
    "muted": "#94a3b8",
    "dim": "#475569",
    "inverse": "#0f172a",
    "empty": "#334155"
  },
  "bg": {
    "base": "#11131a",
    "surface": "#161a22",
    "title": "#0f172a",
    "section": "#18202b",
    "summary": "#1b2430",
    "selected": "#223049",
    "input": "#1e293b",
    "warning": "#2b2116",
    "error": "#2a161b",
    "success": "#14241b",
    "footer": "#111827"
  },
  "state": {
    "info": "#38bdf8",
    "good": "#22c55e",
    "warn": "#f59e0b",
    "bad": "#ef4444",
    "blocked": "#f97316",
    "active": "#60a5fa",
    "reasoning": "#a855f7"
  },
  "accent": {
    "browser": "#7dd3fc",
    "control": "#22d3ee",
    "inspector": "#c4b5fd",
    "workflow": "#fbbf24",
    "conversation": "#93c5fd",
    "brand": "#00ffff",
    "gradientStart": "#00ffff",
    "gradientEnd": "#d000ff"
  },
  "border": "#64748b",
  "chrome": {
    "label": "#94a3b8",
    "faint": "#475569",
    "warn": "#f59e0b",
    "bad": "#ef4444",
    "good": "#22c55e",
    "remote": "#a78bfa"
  }
} as const;

export const CONTRACT_TONE_LIGHT = {
  "fg": {
    "primary": "#e2e8f0",
    "secondary": "#cbd5e1",
    "muted": "#94a3b8",
    "dim": "#475569",
    "inverse": "#0f172a",
    "empty": "#334155"
  },
  "bg": {
    "base": "#11131a",
    "surface": "#161a22",
    "title": "#0f172a",
    "section": "#18202b",
    "summary": "#1b2430",
    "selected": "#223049",
    "input": "#1e293b",
    "warning": "#2b2116",
    "error": "#2a161b",
    "success": "#14241b",
    "footer": "#111827"
  },
  "state": {
    "info": "#0369a1",
    "good": "#22c55e",
    "warn": "#f59e0b",
    "bad": "#ef4444",
    "blocked": "#f97316",
    "active": "#60a5fa",
    "reasoning": "#7c3aed"
  },
  "accent": {
    "browser": "#7dd3fc",
    "control": "#22d3ee",
    "inspector": "#c4b5fd",
    "workflow": "#fbbf24",
    "conversation": "#93c5fd",
    "brand": "#0077aa",
    "gradientStart": "#0077aa",
    "gradientEnd": "#7c3aed"
  },
  "border": "#64748b",
  "chrome": {
    "label": "#64748b",
    "faint": "#94a3b8",
    "warn": "#b45309",
    "bad": "#dc2626",
    "good": "#15803d",
    "remote": "#6d28d9"
  }
} as const;

export const CONTRACT_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏"
] as const;

export const CONTRACT_THINKING_PHRASES = [
  "Thinking...",
  "Vibing...",
  "Manifesting...",
  "Channeling energy...",
  "Tuning frequencies...",
  "Riding the wave...",
  "Aligning chakras...",
  "Entering flow state...",
  "Consulting the void...",
  "Absorbing aesthetics...",
  "Synthesizing vibes...",
  "Transcending...",
  "Dreaming in neon...",
  "Parsing the cosmos...",
  "Loading good vibes...",
  "Meditating...",
  "Catching a vibe...",
  "Harmonizing...",
  "Feeling it...",
  "In the zone..."
] as const;

/** The four contract severity buckets STATE_GLYPHS aliases onto. */
export type ContractStatusState = keyof typeof CONTRACT_STATE_GLYPHS;
