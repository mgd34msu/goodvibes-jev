# Token & Naming Contract (SHARED — read before writing any module)

> Historical record from the July 2026 UX overhaul, kept for provenance. It describes a completed effort's internal planning and does not document current behavior; the living docs are the operator guide and architecture pages.
>
> Superseded (2026-09 WebUI redesign): the token names below were replaced by the slate system in `src/styles/tokens.css` (`--canvas`, `--surface`, `--line`, `--text`, `--accent`, `--ok`, …); the previous palette lives on as the opt-in GoodVibes Neon theme.

All workstreams MUST use these exact names. Foundation defines them in
`src/styles/tokens.css`; every other module references them. Do not invent
parallel names. Do not hardcode hex/px where a token exists.

## Theming mechanism

- Root sets defaults; `:root[data-theme="dark"]` overrides color tokens.
- Dark is the DEFAULT theme. Light is opt-in. Respect `prefers-color-scheme` only
  when the user has expressed no stored preference.
- Density via `:root[data-density="compact"]` overriding `--row-h*` / spacing aliases.
- Honor `@media (prefers-reduced-motion: reduce)` → motion durations collapse to 0.

## Color (semantic) — light + dark variants

```
--surface-base        /* app background */
--surface-raised      /* panels/cards */
--surface-overlay     /* popovers, palette, toasts */
--surface-sunken      /* insets, code wells */
--border-subtle
--border-strong
--border-focus        /* focus ring color */
--text-primary
--text-secondary
--text-tertiary
--text-inverse
--text-accent
--accent              /* primary action (teal) */
--accent-hover
--accent-muted        /* soft accent bg */
--accent-contrast     /* text on accent */
--status-success  --status-success-soft
--status-warning  --status-warning-soft
--status-danger   --status-danger-soft
--status-info     --status-info-soft
/* brand neon — accents/status glow ONLY, never large fills */
--brand-cyan --brand-pink --brand-yellow --brand-purple
```

## Space (4px base)
```
--space-0 (0) --space-1 (4) --space-2 (8) --space-3 (12) --space-4 (16)
--space-5 (20) --space-6 (24) --space-8 (32) --space-10 (40) --space-12 (48)
```

## Radius
```
--radius-sm (6) --radius-md (8) --radius-lg (12) --radius-full (999px)
```

## Typography
```
--font-sans   /* Inter stack */
--font-mono   /* Space Mono stack */
--font-display/* Press Start 2P — brand moments only */
--text-xs (12) --text-sm (13) --text-base (14) --text-md (15)
--text-lg (17) --text-xl (20) --text-2xl (24) --text-3xl (30)
--leading-tight (1.2) --leading-normal (1.5)
--weight-regular (400) --weight-medium (500) --weight-bold (700)
```

## Elevation (theme-aware shadows)
```
--elevation-1 --elevation-2 --elevation-3 --elevation-4
```

## Motion
```
--motion-fast (120ms) --motion-base (180ms) --motion-slow (260ms)
--ease-standard (cubic-bezier(.2,0,0,1))
--ease-spring  (cubic-bezier(.34,1.56,.64,1))
```

## Z-index
```
--z-nav (10) --z-peek (40) --z-overlay (50) --z-palette (60) --z-toast (70)
```

## Layout
```
--sidebar-width (264px) --sidebar-width-collapsed (60px)
--statusstrip-height (32px)
--row-h (36px)  --row-h-compact (28px)   /* density */
```

## Cross-module API names (stable contracts)

- Theme: `useTheme()` → `{ theme, density, setTheme, setDensity, toggleTheme }` from `src/hooks/useTheme.ts`.
- Toast: `useToast()` → `{ toast, dismiss }`; `toast({title, description?, tone?: 'info'|'success'|'warning'|'danger', action?: {label, onClick}, durationMs?})`. From `src/lib/toast.ts` + `ToastProvider`.
- Commands: register via `src/lib/commands.ts` `registerCommand({id, title, group, keywords?, shortcut?, run})`; palette reads the registry.
- Hotkeys: `useHotkeys(bindings)` from `src/hooks/useHotkeys.ts`; respects input-focus guard.
- URL state: `useUrlState()` from `src/hooks/useUrlState.ts` → reads/writes view, session, filters as query params; supports back/forward.
- Peek: `usePeek()` → `{ open, close }`; `open({title, content})` renders a right slide-over.
- Announcer: `useAnnouncer()` → `announce(message, politeness?)` for aria-live.
- ErrorBoundary: `src/components/feedback/ErrorBoundary.tsx` default export, prop `fallback?`.

## Hard rules for all agents

- Use precision_engine tools only (GPA loop). No native Read/Edit/Write/Grep.
- Do NOT edit `src/styles.css` or `src/App.tsx`/`src/main.tsx` unless your
  workstream explicitly owns them (Foundation / Integration).
- New component CSS goes in `src/styles/components/<workstream>.css`, imported by
  the component; never touch another workstream's CSS file.
- TypeScript strict; no `any`/`as any`. Run `bun run typecheck` before finishing.
- Check `.goodvibes/memory/` for patterns/failures before starting.
