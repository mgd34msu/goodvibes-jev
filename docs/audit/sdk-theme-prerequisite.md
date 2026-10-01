# SDK theme prerequisites

This bounded port reconciles the presentation additions in
`mgd34msu/goodvibes-sdk` from
`b419249731bbecc16a8844e5022f401e19e51acb` through
`17eae838461a6529135fe2cad41332d2dc46cb27`, against Jev main
`5957c2be53b6fd5f393885ca00403a9eb4ff8ac6`.

It adds the 18 pure theme modules and presentation-barrel exports: 11 bundled
palettes, reference/variant resolution, color arithmetic, terminal-system
palette generation, and the existing tone-table bridge. The legacy presentation
exports remain available. Tests exercise resolved palettes and contrast,
reference errors, system-palette fallback, bridge compatibility, transparent
token derivation, and a browser-target consumer bundle.

Every new presentation file is PORT: its choices are declared palette/token
keys, explicit mode values, input-format validation, or numerical color and
contrast arithmetic. No module classifies user language or reintroduces a
semantic heuristic. A bounded correction to the upstream resolver lets optional
derived colors accept transparent operands without passing them to hex
arithmetic. System-palette contrast adjustment is best-effort for arbitrary
terminal colors; the tested bundled palettes meet their recorded floors.

## Host adoption

The registry indexes canonical names, matching the pinned upstream source.
Hosts map a saved `vaporwave` alias to `goodvibes-neon` before calling
`getBundledTheme`. `system` is generated from a host-supplied terminal palette,
not a static bundled entry. Hosts own palette probing, appearance mode, and
painting.

## Separate configuration lane

This slice does not change configuration keys, their defaults, credential-key
readings, notification behavior, or product settings interfaces. The
`display.theme` default/enum, `display.treeGlyphs`, and
`behavior.notificationsMetadataOnly` schema additions remain a dependent lane.
The current configured `vaporwave` default therefore remains unchanged here.
The exported `DEFAULT_THEME_NAME` describes the new theme catalog; host adoption
and the configuration default are reconciled separately.

The notification preference must not be exposed as an enforced privacy
guarantee until its actual notification producers consume it and verify that
names, reasons, commands, and paths are omitted.

No WRFC code, provider-matching heuristics, panel-route removals, dependency
changes, version bump, or CI-policy changes are included.
