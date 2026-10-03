# GoodVibes Bash LSP Vendor Patch

This directory vendors `bash-language-server@5.6.0` for the published SDK
package.

Upstream package:

- npm: `bash-language-server@5.6.0`
- npm tarball: `https://registry.npmjs.org/bash-language-server/-/bash-language-server-5.6.0.tgz`
- integrity (sha512): copy the `bash-language-server@5.6.0` entry from `bun.lock` when verifying
- upstream git tag: `v5.6.0` in https://github.com/bash-lsp/bash-language-server
  (run `git ls-remote https://github.com/bash-lsp/bash-language-server refs/tags/v5.6.0`
  to resolve the commit SHA at refresh time)

Refresh procedure (stage upstream separately; preserve and reapply the reviewed
discovery dependency patch described below before replacing this directory):

```bash
TMPDIR="$(mktemp -d)"
npm pack bash-language-server@5.6.0 --pack-destination "$TMPDIR"
tar -xzf "$TMPDIR"/bash-language-server-5.6.0.tgz -C "$TMPDIR"
# Compare the staged source with this copy, reapply the editorconfig and
# discovery-chain patches, then run the regression and packed-consumer checks.
```

`.js.map` files:

- All `out/**/*.js.map` source map files have been deleted from this vendor copy.
  Remove generated source maps again when refreshing upstream source.
- Source maps are not loaded by the runtime language server and are not needed at install time.
- They are intentionally omitted to reduce package size.

Patch:

- `dependencies.editorconfig` is changed from `2.0.1` to `3.0.2`.
- `out/util/fs.js` imports the checked-in fast-glob source by relative path.
  Its discovery implementation and matching options remain unchanged.
- `vendor/fast-glob@3.3.3 -> vendor/micromatch@4.0.8 -> vendor/braces@3.0.3`
  are packaged as source with explicit relative imports between them. Their
  non-vendored leaf dependencies are declared on this package. Braces adds
  finite parser/AST depth checks; see the nested GOODVIBES_PATCH files.
- Bash's original zod 3.24.2 and web-tree-sitter 0.24.5 dependencies use the
  npm aliases `@goodvibes-jev/bash-zod` and
  `@goodvibes-jev/bash-web-tree-sitter`. Runtime and declaration-file imports
  both use these names, preserving versions independently of the engine's
  zod 4.4.3 and tree-sitter 0.26.8 dependencies.

Reason:

- `bash-language-server@5.6.0` pins `editorconfig@2.0.1`.
- `editorconfig@2.0.1` pins `minimatch@10.0.1`.
- `minimatch@10.0.1` is in the vulnerable ranges for
  `GHSA-3ppc-4f35-3m26`, `GHSA-7r86-cg39-jmmj`, and
  `GHSA-23c5-xmqv-rm74`.
- `editorconfig@3.0.2` depends on `minimatch@~10.2.4`, which resolves to the
  fixed `10.2.5` line.

- The latest released braces (3.0.3) is affected by
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  with no upstream fixed release as of 2026-10-03. Latest Bash LSP 5.8.1 and
  fast-glob 3.3.3 still require it. The patched copy rejects excessive nesting
  before recursive walkers, retaining ordinary matching semantics.
- A glob-library replacement was rejected because negative extglobs and
  leading exclusion patterns had observable matching differences. Keeping
  fast-glob/micromatch preserves their existing file ordering, symlink,
  hidden-file, exclusion and stream-limit behavior.
- A root-only braces override would not protect published engine consumers.
  Nested `file:` dependencies also failed a fresh npm-consumer proof. Relative
  imports plus explicit external leaves ensure the reviewed implementation
  travels with this package. The `files` list includes the nested `vendor` tree.
- npm also skips dependencies of the engine's outer linked Bash directory.
  Release staging therefore projects Bash's declared leaves into the engine's
  optional dependencies, rejects version collisions, and leaves engine versions
  intact. Pack and fresh engine-consumer checks verify the source guard, file
  discovery, alias versions and actual wasm parsing.
- Bun 1.3.14 can omit the optional local-directory link itself. The engine's
  existing LSP resolver therefore checks its embedded Bash CLI after installed
  `.bin` paths, only for the Bash command. The source-checkout fallback is gated
  to the source-module layout. Canonical tarball smoke tests both npm and Bun;
  the Bun run uses the existing LSP API for a real initialization handshake and
  shutdown, so source presence alone is not treated as feature availability.

The rest of the runtime Bash LSP code is unchanged from the upstream npm package.
The committed `out/` JavaScript directory is intentionally retained from the
upstream published package so GoodVibes can pack and run the Bash language
server without executing the vendored package's build or publish lifecycle
scripts during SDK installation. Source map files are omitted from the vendor
copy because they are not loaded by the runtime language server.
Remove this vendor package when upstream `bash-language-server` publishes a
release that depends on fixed `editorconfig`/`minimatch` and braces chains.

Verification: run the engine's `dependency-braces-depth`, `lsp-bash-file-discovery`,
and `lsp-bash-bundled` tests, then pack this package and install that tarball into
a fresh consumer with npm. Verify the consumer discovers files and uses the
checked-in brace guard; a workspace audit alone cannot prove packaged safety.
