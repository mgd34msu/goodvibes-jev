# Vendored micromatch source

Source: `micromatch@4.0.8`, https://github.com/micromatch/micromatch

Official tarball: https://registry.npmjs.org/micromatch/-/micromatch-4.0.8.tgz

Integrity: `sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA==`

The original version and MIT LICENSE are retained. The only runtime change is
`index.js` importing `./vendor/braces` instead of the registry package. All
matching code remains original, including custom negative-extglob semantics.

Metadata removes development scripts/dependencies and the registry braces
dependency, marks this source-only copy private, and includes vendor/provenance
files. The non-vendored picomatch leaf is explicitly declared by Bash LSP.
Refresh/remove together with fast-glob and braces after dependency, matching,
depth-limit and fresh packed-consumer verification.
