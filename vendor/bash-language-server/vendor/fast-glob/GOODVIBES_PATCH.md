# Vendored fast-glob source

Source: `fast-glob@3.3.3`, https://github.com/mrmlnc/fast-glob

Official tarball: https://registry.npmjs.org/fast-glob/-/fast-glob-3.3.3.tgz

Integrity: `sha512-7MptL8U0cqcFdzIzwOTHoilX9x5BrNqye7Z/LuC7kCMRio1EMSyqRK3BEAUD7sXRq4iT4AzTVuZdhgQ2TCvYLg==`

The original version and MIT LICENSE are retained. The only runtime change is
`out/utils/pattern.js` importing `../../vendor/micromatch` instead of the registry
package. The walker, stream implementation and pattern options are unchanged.
This makes the patched braces dependency available in published Bash LSP
consumers without relying on root overrides or nested local-file installations.

Metadata removes development scripts/dependencies and the registry micromatch
dependency, marks this source-only copy private, and includes vendor/provenance
files. External runtime leaf dependencies are also explicitly declared by the
installable Bash LSP package. Keep README/LICENSE from the original tarball.

Refresh only alongside the complete reviewed chain. Compare runtime files
against the official tarball, retain the relative import, and run discovery,
brace-depth and packed-consumer checks. Remove this source copy when upstream
can supply a safe brace implementation without changing supported matching.
