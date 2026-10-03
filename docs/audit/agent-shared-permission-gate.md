# Agent shared permission gate adoption

## Source finding

At main `4e25f519`, Agent bootstrap installed its product-local permission safety
wrapper. A thrown `check` or `checkDetailed` became an approval for table-named
reads, including `read` and `fetch`. Detailed checks fabricated `config_allow`,
`runtime_mode`, and low-risk provenance. The existing hoisted engine wrapper
instead asked Jev for a side-effect category, but still treated that category as
alternate authority after any manager failure and dropped attribution/options.

## Repair boundary

- Bootstrap installs the existing shared wrapper through its actual
  `composeAgentPermissionManager` seam. The former local implementation is only
  a compatibility re-export; all local tool/action classification tables are gone.
- The shared wrapper preserves complete method arguments and an execution-options
  snapshot, including signal and hook ownership, and races cancellation through
  the existing shared permission lifetime helper. It returns only the manager's
  decision. It does not recover authority from a second category reading, fabricate
  a permission result, retry locally, or request human approval.
- The policy-explanation consumers await the existing shared Jev category reader.
  Category confidence is exposed separately from permission, which remains
  unknown/not evaluated. Unavailable readings propagate. An uncertain reading is
  explicitly described as uncertain and never certifies approval. Both callers
  forward cancellation through the shared category reader into the side-effect
  battery; an abort-ignoring reader cannot return a late explanation. The complete
  explanation input is detached and validated by the existing full-size judgment
  boundary before lookup or await. Its same immutable tool arguments feed every
  later analysis, guard, confirmation, and display consumer; accessors are refused
  without invocation. The harness
  keeps this judgment outside its generic error-to-display-text catch.

## Offline evidence

The Agent regression builds real `createRuntimeServices` graphs, invokes the same
permission composition as bootstrap, and routes `executeToolCalls` into
nonexecuting fake `read`/`fetch` bodies. Judgment responses are typed fixtures;
there are no live providers, credentials, network tools, or file-reading tools.

- Throwing and unavailable manager checks never reach either fake body.
- A real manager with missing judgment never approves a read.
- Cancellation settles an abort-ignoring check and discards its eventual approval.
- Revocation reported by the authority while waiting is propagated, not replaced
  by a fallback approval.
- Both actual explanation callers resist nested argument mutation during pending
  judgment and refuse outer/nested getters without invoking them or Jev.
- Both public check methods preserve attribution, full execution options, hook
  ownership, and immutable argument identity.
- Successful real Jev readings retain decision-log entries; failed readings retain
  failure entries without synthetic `config_allow` provenance.
- Reinstating the old local wrapper in the bootstrap composition makes both
  throwing read/fetch controls fail by executing the fake action.
- Reinstating the old shared wrapper makes both full-signature controls fail by
  dropping attribution and execution options.

## Explicit dependencies and limits

THE116 owns the shared judgment/gate retry contract and current-authority
revalidation. This repair does not introduce an independent retry loop, increase
bounded retry budgets, or claim that the manager already refreshes every preset
or authority generation after a pending reading. It preserves the current shared
executor's pending/typed failure contract rather than guessing a local outcome.

The explanation surface still reports existing tool-declared `confirm:true` and
`explicitUserRequest` contracts. Removing human-confirmation semantics is a shared
policy migration, not completed by this wrapper repair. No claim of full
autonomous migration is made here.
