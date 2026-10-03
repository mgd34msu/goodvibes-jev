# HTTP cache semantics security patch

This is the published `http-cache-semantics@4.2.0` source, locally patched for
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
The original version and BSD-2-Clause license are retained. This is not an
upstream fixed release. As of 2026-10-03 the advisory lists no fixed release,
and the npm registry's latest version is still 4.2.0.

## Provenance

- Upstream: https://github.com/kornelski/http-cache-semantics
- Original tarball: https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.2.0.tgz
- Tarball integrity: `sha512-dTxcvPXqPvXBQpq5dUr6mEMJX4oIEFv6bwom3FDwKRDsuIjjJGANqhBuoAn9c1RQJIdAKav33ED65E2ys+87QQ==`
- Original `index.js` SHA-256: `01b7d66c854b2fe53ac05c98feb6e0d64722ab8898a778e2d2426a8b468d178f`
- Original README and LICENSE are unchanged.
- Package metadata omits upstream development-only scripts/dependencies and adds
  patch provenance. No package version is invented to escape the advisory.

## Behavioral change

Upstream distinguishes expiry by `maxAge()`, but sets that value to zero for
security restrictions too. A client `max-stale` directive can override the
zero and cause a forbidden cached response to be returned.

The added `_hasReuseProhibition()` guard independently checks the existing
security-zero conditions: non-storable responses, `no-cache`, `Vary: *`, and
shared-cache `proxy-revalidate` or cookies without the existing `public` or
`immutable` opt-in. The guard runs before request reuse and also blocks stale
extensions, stale-on-error fallback, and retention TTL for these responses.
It is computed from existing serialized fields, so previously stored entries
receive the same protection after `fromObject()`.

Ordinary expiry, including an explicit `max-age=0`, keeps its existing stale
semantics. Public/immutable cookie opt-ins, private caches, conditional
revalidation and the existing independent `must-revalidate` behavior remain
unchanged. In particular, this patch does not globally reject zero-lifetime
responses or alter fresh `must-revalidate` TTL.

## Dependency scope and verification

The root override is used only by the development/release-test chain
`verdaccio -> @verdaccio/hooks -> got-cjs -> cacheable-request`. It is not an
engine runtime dependency. No audit exception or severity change is made.

`packages/engine/test/dependency-cache-policy.test.ts` verifies the installed
consumer's source is exactly this file, exercises cache-reuse restrictions
with synthetic data, checks ordinary caching/revalidation compatibility, and
uses the real Verdaccio HTTP client against a loopback fixture.

The initial 15 behavioral regressions gave 11 failures against original 4.2.0
and all passed after the source patch. A clean frozen install was also tested:
Bun's incremental install can leave an old transitive symlink when introducing
a file override, which the installed-source assertion catches.

## Refresh and removal

Retain this override until an upstream release or parent dependency removes
the vulnerable behavior. At refresh, download the official npm tarball,
verify its integrity, compare the source and license, and rerun the behavioral
and installed-resolution tests. Remove the override/vendor copy only when
those tests pass against the replacement and the unchanged high-severity
audit passes. An audit pass alone does not establish that this local source
patch is correct; its review and regressions are required.
