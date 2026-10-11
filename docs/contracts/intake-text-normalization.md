# Structural intake text normalization

THE-111 adds four pure, deterministic host-side functions to the existing
`@goodvibes-jev/engine/sdk/platform/intake` subpath. They are implemented in
`packages/engine/sdk/src/platform/intake/text-normalization.ts` and perform no
network/provider calls, writes, tagging, credential access or model inference.

## Public contract

| Function | Behavior |
|---|---|
| `sha256First(input, hexChars)` | SHA-256 over the input's UTF-8 bytes, lowercase hex, followed by `slice(0, Math.max(0, hexChars))`. Negative/NaN widths return empty text, fractional widths truncate, and widths beyond 64 (including infinity) return all 64 hex characters. |
| `digestSender(senderExternalId)` | First 16 hexadecimal SHA-256 characters, with no case, whitespace or Unicode normalization. This is a stable pseudonymous token, not proof of anonymity or collision freedom. |
| `stripMarkup(input)` | Uses the retained upstream structural MIME/HTML grammar described below. Returns text without applying a whitespace or length budget. |
| `normalizeWhitespace(input)` | Collapses JavaScript `\s+` to one ASCII space and trims. Does not truncate or redact. |

All inputs are required strings; digest width is a required number. These
functions are Node/Bun host-only and are not exported from the browser facade.

## Retained structure and deliberate limits

Multipart recognition requires a boundary-shaped line and a Content-Type
occurrence. The first boundary is escaped before constructing the splitter.
Parts require a blank-line header/body separator; the first `text/plain` body
wins even when empty, otherwise the first `text/html` body wins, otherwise the
original input is retained. Content types ignore case and semicolon parameters.
The selected body then passes through the same header/markup/entity removal.

This is the upstream lightweight text transform, not a general MIME parser.
There is no recursive multipart expansion, charset conversion, attachment
interpretation, or base64/quoted-printable decoding. The splitter retains its
upstream unanchored boundary matching. Header removal is line-oriented, including
matching lines inside a body, and requires a trailing newline; folded headers
are not unfolded, and a final unterminated header/boundary line can remain.

Complete script/style blocks are removed case-insensitively. Supported block
tags become spaces; remaining complete tags are removed only when a tag-shaped
match exists. Incomplete markup is not repaired. It is not an HTML sanitizer:
entity decoding happens after tag removal, so encoded tags can become literal
tags in the output. Render this result as text rather than HTML.

The small case-insensitive named set is `amp`, `lt`, `gt`, `quot`, `apos`,
`nbsp` and `&#39;`. That pass precedes one decimal pass accepting one through
seven digits. Valid Unicode scalars from U+0000 through U+10FFFF decode; surrogate
values U+D800 through U+DFFF and out-of-range numbers stay literal. Unknown,
hexadecimal and malformed entities stay literal. Named entities are not decoded
recursively. Scalar validation is the sole intentional behavior change from the
pinned source: out-of-range decimal entities no longer throw and surrogate
entities no longer produce isolated surrogate code units.

## Source attribution and validation

Source: [goodvibes-daemon mapping.ts](https://github.com/mgd34msu/goodvibes-daemon/blob/254699bf5d834cdca41436211ada1ae32bf89258/src/daemon/handlers/inbox/mapping.ts),
blob `117965d4debe0783215f52f9dcc36278aeba6428`.
Retained digest, markup and MIME fixtures come from
[mapping.test.ts](https://github.com/mgd34msu/goodvibes-daemon/blob/254699bf5d834cdca41436211ada1ae32bf89258/src/test/daemon/inbox/mapping.test.ts),
blob `cddb13456910653f1e9a43fffcce04df51a3d0fc`.

The deterministic tests cover the retained fixtures, hash width/UTF-8 semantics,
MIME preference and fallback, literal regex-metacharacter boundaries, malformed
parts, header limitations, markup, whitespace and entity ordering, scalar
endpoints, every surrogate and invalid decimal values. Consumer-vantage type
tests pin the four published declarations.

## Work still open

These helpers do not make privacy-safe previews. Semantic credential, personal
data and phone-number extraction, `stripPii`, `toBodyPreview`, `toSubjectPreview`,
preview length budgets, full adapters and daemon wiring remain outside THE-111.
Existing triage API approval and legacy IMAP framing are unchanged. No approval
to upload message text, release, merge or deploy is implied by this module.

The additive [protected local source owner](protected-source-screening.md) now
provides an explicit local-only proposal/verification mapper prerequisite. It
does not make these structural helpers privacy redactors, install default
providers, or establish live semantic accuracy.
