# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest published minor line (currently 2.0.x) | :white_check_mark: |
| Earlier minor or major lines | :x: |

Security fixes land in the latest published minor line. Earlier lines are not patched; upgrade to the latest release to receive security updates.

## Dependency audit disclosures

The repo uses package-manager overrides for transitive advisory remediation when
the upstream dependency range has not yet moved but a compatible fixed package is
available. Current non-vendored overrides are declared in the root
`package.json`:

- `fast-xml-parser@5.7.1` for the AWS XML builder path
- `google-auth-library@10.6.2` for Cloudflare/Wrangler transitive auth tooling
- `minimatch@^10.2.5` for source-workspace installs
- `fast-uri@^3.1.5` to avoid `GHSA-v39h-62p7-jpjc` in AJV consumers used by release tooling
- `esbuild@0.28.1` to close `GHSA-gv7w-rqvm-qjhr` (RCE via missing binary integrity verification in the Deno module path)
- `form-data@4.0.6` to close `GHSA-hmw2-7cc7-3qxx` (CRLF injection via unescaped multipart field/file names)
- `ws@8.21.0` to close `GHSA-96hv-2xvq-fx4p` (memory-exhaustion DoS from tiny fragments)
- `undici@^7.29.0` to close `GHSA-vmh5-mc38-953g`, `GHSA-vxpw-j846-p89q`, and `GHSA-hm92-r4w5-c3mj` (TLS bypass, WebSocket DoS, SOCKS5 routing); also a direct dependency at the same version, not only a transitive override
- `tar@^7.5.16`, `brace-expansion@^5.0.9`, `sharp@^0.35.0`, and `ip-address@^10.4.0`, later additions to the same override table for transitive advisory remediation; `brace-expansion` and `ip-address` are also direct dependencies at the same pinned version. See the `overridesRationale` field in the root `package.json` for the per-package justification on file; a package listed here without a corresponding `overridesRationale` entry is pinned as a precaution and does not yet have a recorded rationale.

The engine's optional `simple-git` is pinned to 4.0.2, which requires the patched
`@simple-git/argv-parser@2.0.1`. This closes `GHSA-x6jw-m9v5-85vh`,
`GHSA-g4wm-2vf7-vfgr`, `GHSA-858h-whjf-mvg5`, and `GHSA-v5rq-49vh-5v5c`;
4.0.1 alone still pins the vulnerable argument parser. The v4 migration preserves
the host's `GIT_CEILING_DIRECTORIES` discovery boundary, with `GIT_DIR` and
`GIT_WORK_TREE` allowed only for the checkpoint runner's own routing. Other
inherited Git variables and unsafe editor/config variables are excluded from its
explicit environment. No new unsafe-operation escape hatch is enabled.

The source-workspace lock resolves `source-map-js@1.2.2` for jsdom/css-tree and
Vite/PostCSS, closing `GHSA-68fv-2mgg-jv7q`. Their existing ranges accept the fix,
so this is a targeted lock refresh without an additional override. Regression
tests exercise both actual consumer paths and reject excessive indexed-map
offsets before allocating a flattened map.

The published SDK keeps Bash LSP bundled as a first-class feature. The
`bash-language-server@5.6.0 -> editorconfig@2.0.1 -> minimatch@10.0.1` chain is
handled as a graph-level vendor patch: `vendor/bash-language-server` copies the
upstream `bash-language-server@5.6.0` package and changes
`dependencies.editorconfig` to `3.0.2`, whose dependency range resolves to the
fixed `minimatch@~10.2.4` line (the root `overrides.minimatch` separately pins
`^10.2.5` for source-workspace installs). Release staging rewrites the published SDK
dependency to `file:vendor/bash-language-server` and projects its runtime leaves
into the installable engine manifest, because npm does not install dependencies
of that linked directory. Explicit Bash zod/tree-sitter aliases preserve the
engine's existing versions. Fresh packed-engine smoke checks exercise discovery,
the brace guard and wasm parsing; consumers do not rely on root-only overrides
for these vendored patches.

Bun 1.3.14 may omit that optional local-directory package link even though the
reviewed Bash files are present in the engine tarball. The existing LSP service
therefore falls back to the engine's embedded Bash CLI after its normal `.bin`
lookup; no download or replacement server is used. Tarball install smoke now
checks both npm and Bun, including the real Bash LSP initialize/shutdown flow
under Bun. The public LSP API and normal installed-binary precedence are unchanged.

No install-time minimatch mutation is used. The Bash LSP mitigation is carried
by the published dependency graph itself.

The unpatched `braces@3.0.3` advisory `GHSA-vfj7-8cjw-p6xm` is addressed with
a finite parser/AST depth guard in a source-vendored fast-glob/micromatch/braces
chain inside the Bash LSP package. Original versions, licenses and source
integrities are recorded alongside the code. Ordinary matching is unchanged;
excessive nesting is rejected before recursive walkers. Tests cover original
matching semantics, nesting boundaries, direct AST entry points and installed
source identity. Root overrides alone are insufficient for shipped consumers.

The optional local-registry release smoke lane and its Verdaccio dependency have
been removed. Its registry publish/install and dependency-specific regression
tests are intentionally retired. The independent release dry-run, install smoke
checks and high-severity dependency audit remain enabled.

Application roots that audit the SDK dependency graph should set their own
root-level overrides for the non-vendored packages if their package manager does
not inherit dependency-package overrides:

```json
{
  "overrides": {
    "ajv": "8.18.0",
    "esbuild": "0.28.1",
    "fast-uri": "^3.1.5",
    "fast-xml-parser": "5.7.1",
    "form-data": "4.0.6",
    "google-auth-library": "10.6.2",
    "minimatch": "^10.2.5",
    "undici": "^7.29.0",
    "ws": "8.21.0",
    "tar": "^7.5.16",
    "brace-expansion": "^5.0.9",
    "sharp": "^0.35.0",
    "ip-address": "^10.4.0"
  }
}
```

The `bash-language-server` vendor-patch override is omitted from this snippet;
it is a file-path override (`file:vendor/...`) specific to this repo's Bash LSP
bundling, not a remediation an application root reproduces.

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Report security issues privately via GitHub private vulnerability reporting:

- **GitHub private vulnerability reporting**: Use the [Security tab](https://github.com/mgd34msu/goodvibes-sdk/security/advisories/new) on this repository

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations (optional)

## Response SLA

| Severity | Initial Response | Fix Target |
|----------|-----------------|------------|
| Critical (CVSS 9.0+) | 24 hours | 7 days |
| High (CVSS 7.0–8.9) | 48 hours | 14 days |
| Medium (CVSS 4.0–6.9) | 5 business days | 30 days |
| Low (CVSS < 4.0) | 10 business days | Best effort |

Reporters will be notified when the vulnerability is confirmed, when a fix is staged, and when a release ships.

## Scope

Security-sensitive areas in this SDK include:

- Bearer-token handling
- Session login flows
- Token persistence adapters
- Realtime event streams
- Daemon route embedding
- Structured error propagation

## Consumer guidance

The full security model covers authentication modes, token management, secret handling, and daemon hardening. See [docs/security.md](./docs/security.md).

When building with this SDK:

- Prefer bearer tokens for service-to-service and mobile companion clients
- Use secure storage for persisted tokens
- Avoid logging raw credentials or bearer tokens
- Treat structured error fields as telemetry or debug metadata. Do not expose them directly to end users without review
- Validate CORS and cookie/session assumptions explicitly when using browser session auth
