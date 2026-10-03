# Braces nesting security patch

Source: `braces@3.0.3`, https://github.com/micromatch/braces

Official tarball: https://registry.npmjs.org/braces/-/braces-3.0.3.tgz

Integrity: `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`

Original version, README and MIT LICENSE are retained. This is a local source
patch, not a released upstream fix. The latest npm release remains affected by
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
as of 2026-10-03. The upstream issue is
https://github.com/micromatch/braces/issues/70.

## Patch and intentional limit

The parser checks its combined brace/parenthesis stack before opening either
kind of group. Quotes, escapes and bracket literals retain their existing
handling. The public and direct-library compile, expand and stringify entry
points perform an iterative AST walk before their recursive implementation,
rejecting excessive depth or child cycles with a controlled SyntaxError.
The AST depth limit is 128 edges; parsed nested groups are limited to 127 to
leave room for a terminal child. Callers cannot disable the bound through
options. Ordinary matching/expansion code is unchanged.

This is an intentional input-validation limit, analogous to upstream's
existing length and expansion limits. Excessively nested custom patterns now
fail predictably before stack exhaustion. The Bash LSP already catches a file
discovery error and reports degraded background analysis instead of crashing.

The new `lib/nesting.js` is used by `parse.js`, `compile.js`, `expand.js` and
`stringify.js`. Metadata omits development scripts/dependencies, marks this
source-only copy private, and adds this provenance file. Fill-range stays an
external declared Bash LSP dependency. No advisory exemption is added.

## Verification and maintenance

`packages/engine/test/dependency-braces-depth.test.ts` covers ordinary expansion,
quoted/escaped literals, the permitted/rejected parser boundary, mixed groups,
direct AST/library entry points, cycles and installed-source identity.
File-discovery regressions retain the original matcher, including negative
extglobs, exclusions, dot files, links, ranges and stream caps.

At refresh, compare with the official tarball and re-review the guard before
replacing source. Remove this patch and the nested source chain only once an
upstream replacement passes the same depth, compatibility and packed-consumer
checks and the unchanged high-severity audit.
