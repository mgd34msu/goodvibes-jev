# ACP subagent and hosted intake caller adoption

Original rows: A-F1072 (SDK ACP connection) and A-F1540 (hosted spine intake).
Base: a3dc84161bcbc368351ce6ec7d51e0e5419edb77.
Dependency: 440cff938313101171470f426dc968b34753ddd7 owns the shared failure-transience reading options and immutable failure-input capture. Those shared files are not duplicated in this contribution.

## Reachable behavior

- TUI bootstrap supplies the recorded canonical permission owner to AcpManager.
- Admitted delegate tool execution supplies currentExternalOperationSource; the manager captures the original goal/criteria and rejects changed authority. Generated child task prose is never a source fallback.
- Both direct `/remote dispatch` variants carry the exact original terminal command through the private direct-owner marker and explicit session/manager lifetime. Model/source-less invocations refuse before spawning. Pairing replacement commands now preserve the raw input through that same boundary.
- AcpConnection uses admitExternalRequest and AcpPermissionWire: protocol privacy capture, exact original option IDs, no widening from once to always, final synchronous wire claim, cancellation/config/source fences, and no human callback fallback.
- Hosted intake uses captureJudgmentFailure and readFailureTransience over the actual failure. The attempt ceiling applies only after retry eligibility. Failed readings retain collected inputs and retry classification without resending the input. Unsafe evidence never reaches the reader or becomes a redelivery.
- Stop/fence prevent stale classification effects. Successful turns still finish their existing shutdown drain. Reader exception observability uses fixed text and source identities without raw exception wording.

## Qualification

Synthetic inputs only, Bun 1.3.14 with `--no-env-file`; no live keys or providers.

- Official engine six-file suite passed 125 tests / 368 assertions before the final async-guard cases and remote caller additions. Files: acp-connection-autonomous, hosted-session-spine-intake, external-autonomous-permissions, acp-host, acp-permission-outcome, acp-connection-usage-mapping.
- Official TUI remote-command + host-pairing-shell suite passed 36 tests / 446 assertions after the actual direct-command-to-subprocess proof and raw pairing replacement fix.
- ACP fixtures exercise real spawned stdio peers through the optional ACP SDK, canonical recorded PermissionManager and original protocol response IDs. The originating manager source is checked separately from generated task prose.
- Hosted fixtures cover opposite semantic outcomes, bounded retry, structured-status fast paths, captured port isolation, stop/fence, failed-read retry, immutable original failures, privacy rejection, and secret-bearing reader exceptions.
- Independent final review passed 38 engine ACP/hosted tests and 36 TUI remote/pairing tests on the final source, with no remaining source blocker.
- `git diff --check` passed.

An initial forced engine/test typecheck found two implicit option callback types and one exact-optional property declaration; all three source defects were corrected. No successful final typecheck is claimed by this leaf. The integration owner will run the single final aggregate root/product typecheck and regenerate composed API reports. The independent final focused review result accompanies the commit receipt.
