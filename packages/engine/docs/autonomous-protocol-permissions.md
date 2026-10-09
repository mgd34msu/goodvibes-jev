# Autonomous ACP and MCP protocol decisions

Runtime compositions use `PermissionManager.admitAutonomous` for hosted ACP permission requests and MCP form responses. That is the same owner used by native tools: it reads the existing Jev batteries, enforces configured restrictions, obtains a typed autonomous disposition, records supporting decisions, and claims an exact action once. There is no default human approval callback, risk-to-allow shortcut, or second retry loop.

## ACP hosting

The host captures the original prompt as the goal, the current ACP session and process, the complete permission request and its original options. Prompts cannot overlap on one session because ACP permission requests identify their session, not the prompt that caused them.

A current `act` claim selects only an original `allow_once` option. `reject` selects `reject_once` when offered. A deferred/revised decision, missing once option, duplicate option/request identity, unavailable judgment, cancellation, or changed authority cancels the request. No decision silently expands to `allow_always`.

The response object is bound privately to its original request incarnation. The canonical claim is deferred until the SDK message sink performs the actual synchronous byte write; a stale result or replay cannot claim a reused RPC ID. Stopping invalidates permission work before waiting for ACP cancellation. Process exit, prompt completion, runtime disposal, and settings invalidation also retire pending work.

## MCP elicitation

An MCP request is untrusted evidence, not the authority to disclose facts. An admitted tool operation carries its original goal and already supplied structured facts through a process-local scope. The registry binds that scope to the exact server client and its current trust/role/quarantine lifetime.

The handler considers only complete, exact fact objects matching the original supported form schema. It never fills defaults, invents values, or fabricates consent. When several exact candidates fit structurally, the existing typed autonomous resolver selects an offered candidate; a fresh canonical permission admission then judges sending that exact content to that exact server. Selection decision IDs are included in the final admission. Missing source/facts or unsupported schemas cancel; a typed rejection declines.

Acceptance is not committed when the response object is constructed. Its private single-use claim is checked at the final stdio write, HTTP POST, or MRTR continuation. Connection replacement, HTTP session replacement, operation completion/cancellation, server-policy changes (including A→B→A), and runtime disposal prevent late acceptance.

Supported forms are objects of primitive or array fields, with explicitly validated type/enum/const/choice, numeric, string, and array constraints. Unknown schema keywords, arbitrary regular-expression patterns, references, defaults, coercion, protected credential/card data, and unsupported formats fail closed. Validation returns the original owned content, never transformed parser output.

## Transport coverage and limits

- Modern MCP MRTR, including stdio, has direct operation association through `inputRequests` in the originating tool result.
- Legacy HTTP SSE uses the originating POST stream's operation scope, preserving concurrent request separation.
- Legacy unsolicited stdio requests do not carry a supported parent-operation association. They cancel rather than borrow the latest turn or another tool's source. This is an explicit compatibility limit, not complete legacy-stdio autonomy.
- This implementation selects supplied structured facts. It does not extract arbitrary new form values from prose, execute URL-mode login flows, or invent a missing answer.
- The separately exported deprecated human elicitation helper remains an explicitly selected compatibility adapter. Neither runtime composition installs it.

The [official transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) associates HTTP server requests with stream membership. `relatedRequestId` in the [official SDK example](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/elicitation/server.ts) is a server-side routing option, not a serialized field that clients may assume exists.

## Verification

`external-autonomous-permissions.test.ts` uses synthetic recorded Jev answers and intercepted transports. It covers typed act/reject, conflicting prose, exact facts, unsupported/protected inputs, immutable/single-use responses, concurrent HTTP operations, process/session replacement, configuration invalidation, duplicate requests, and ACP stopping while cancellation is pending. A scripted ACP process exercises the actual SDK wire protocol. These are integration and mechanism tests, not live-model calibration evidence.

## Autonomous MCP tool dispatch

The actual Agent facade now conditionally forwards `callTool` and `getToolSchema`
to its registry owner. Cancellation reaches the registry and final transport write.
A default coherent high/critical `ask-on-risk` request, or coherent medium request
under `constrained`, is an eligible risk-policy ask. The registry admits it through
the same canonical autonomous owner used by native tools. Uncertain capability,
facts, family, boundary or scoped-value readings cannot become eligible asks;
explicit denies and constrained high/critical requests remain refused.

Destination and configured server policy are detached, protected-input-screened
host evidence. An opaque adapter token prevents remote metadata from impersonating
that evidence. Canonical risk readings and disposition see its meaning, and the
receipt input revision covers it without changing the actual arguments or original
source. Evidence never overrides structural restrictions. Live policy, source,
connection, destination and cancellation guards run before judgment attempts and
at writes. One logical tool admission is claimed at the first `tools/call` write;
MRTR continuations retain those guards and independently claim each input response.

Synthetic qualification covers actual stdio and HTTP writes, the real Agent route
and facade, typed non-act results, scoped uncertainty, endpoint/policy/source swaps,
reconnect, delayed schema loading, cancellation, and MRTR revocation. These proofs
do not assert live-provider calibration or support for uncorrelated legacy input.
