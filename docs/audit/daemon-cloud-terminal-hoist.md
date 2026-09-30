# Cloud terminal backend hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
`src/daemon/handlers/remote/backends/cloud-terminal.ts`.

The factory now lives under engine `runtime/remote/host/backends`, exported
through runtime operations. Its GCP, AWS and Azure executable/argument choices,
provider credential environment variables, optional fields, remote-shell args
and timeout-to-124 mapping remain the pinned-source contract. Mock assertions
cover all three provider command forms. This is argv compatibility evidence,
not proof of a configured cloud account or successful remote execution.

## Corrected failures

The initial focused run against the imported source passed four cases and
failed six. The port corrects:

- Exact known credential bytes could be returned in CLI output, and credential
  store exceptions could disclose their contents. The known resolved value is
  removed by literal byte-string equality from stdout/stderr, and failed
  lookups report a fixed typed error. No model, regex classifier or semantic
  secret detector reads the credential
- Raw peer IDs could select paths outside the credential directory. Files now
  have generated names within the instance's owned directory
- Constructing/tearing down one instance could delete another's active file.
  Each instance now owns only its marked private directory beneath the same
  legacy `cloud-creds` root
- A lookup resolving after teardown could resume dispatch and recreate files.
  BackendLifetime rejects that continuation and refuses subsequent calls
- Teardown did not stop active CLI work. Cancellation now stops/reaps the
  locally owned child before its credential file is removed

Single-use files are removed in a finally block. The shared scratch helper's
new single-file cleanup accepts only paths this instance created, verifies the
directory identity and leaves legacy/unowned files alone. Non-credential CLI
output stays unchanged. Literal masking is limited to the known resolved value;
it is not a claim to detect unrelated secrets or transformed fragments.

## Verification boundary

The combined cloud, scratch/lifecycle, process, basic-backend and peer-registry
run passes 89 guarded tests across seven files. Every cloud CLI spawn is
intercepted, including teardown paths. Only dummy credential strings and
temporary fixture directories are used. No cloud account, provider permission,
real credential store, persistent key or remote endpoint is configured.

SSH, the all-backend factory, dispatcher and complete daemon composition remain
subsequent slices. Existing public route/admin admission must still be retained.
Upstream release deltas remain a separate gate before final product parity.
