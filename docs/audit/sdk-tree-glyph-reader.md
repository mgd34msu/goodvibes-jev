# Read-only tree-glyph prerequisite

Base: `78fe0bb031cc827018567c8bec4cfe24eab1283b`.

## Source contract

The pinned TUI [conversation caller](https://github.com/mgd34msu/goodvibes-tui/blob/ec057c33979839be84a1d8d2399f9c69f0c2a5aa/src/core/conversation.ts#L568-L571)
reads `display.treeGlyphs` for every render. Its
[renderer resolver](https://github.com/mgd34msu/goodvibes-tui/blob/ec057c33979839be84a1d8d2399f9c69f0c2a5aa/src/renderer/lane-graph/glyphs.ts)
accepts only `rounded | square | ascii`, defaults to rounded, and forces ASCII
when the host's Unicode capability is false. SDK target
`17eae838461a6529135fe2cad41332d2dc46cb27` has the matching schema choices;
that persisted schema remains a separately gated change in Jev.

## Public prerequisite

`runtime/operations` exposes `TREE_GLYPHS_CONFIG_KEY`,
`TreeGlyphSetName` and `readTreeGlyphSet(configGet, unicodeCapable)`.
It reads the exact key once on each call, uses the same closed enum/default,
catches old or malformed getters and contains asynchronous rejections without
accepting an eventual style. The terminal capability always wins.

This installs no ConfigKey, schema entry, persisted default, setting control or
write path. Host adapters retain their generic string-key config read seam;
terminal capability probing, glyph tables and rendering remain host-owned.
The reader is purely structural presentation selection, with no text judgment.

## Proof

The regression composes the public reader with the exact pinned upstream
renderer module stored as a test-only fixture (no product-code duplication).
It verifies real rounded/square/ASCII corner rendering, all valid and malformed
values, live changes, throwing/old getters, and real ConfigManager disk reloads
without writing through the reader. An owned, bounded Bun subprocess proves
rejecting promises, late failures and throwing then accessors cannot escape;
resolved async styles remain invalid.

A getter that throws a rejecting Promise is contained too, with unchanged
rounded/forced-ASCII fallback. The real child-process proof covers both returned
and thrown asynchronous values without logging or retaining their failures.

## Publication verification

The actual reader, ConfigGet and focus-tracker dependency graph passed the
repository's strict compiler options. Checked declaration emission for all three
modules is byte-identical to the earlier checked source that generated the
three public API additions. Those verified generated additions are mechanically
composed with the current-main snapshot, including its optional repair signal.
No public declaration text was inferred or invented.

The earlier whole-tree hook and later checked SDK declaration attempts were
signal-terminated without TypeScript diagnostics; their logs are retained. A
separate noCheck artifact-emission pass completed but produced unrelated API
ordering changes, which are preserved separately and excluded from this patch.
Fresh whole-SDK checked API equality was therefore not established locally.

The merged repository policy runs the credential-scope hook at publication.
Whole-tree build, types, checked API extraction, product and containment checks
remain required on this exact head in CI before merge. The local narrow proof
and independent review do not substitute for those gates or establish product
adoption of the still-gated persisted setting.
