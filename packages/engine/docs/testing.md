# Testing architecture

> Internal source map. For day-to-day validation commands see [Testing and Validation](./testing-and-validation.md).

Tests should protect architecture, not just implementation details.

Key expectations:

- source-of-truth packages and SDK facades resolve through public entrypoints
- client-safe surfaces do not import runtime-heavy dependencies
- base knowledge and Home Graph Ask stay behaviorally aligned for concrete
  subjects
- repair tasks are durable, observable, bounded, and retryable
- generated pages update from promoted graph facts and source links
- route harnesses avoid overlapping long Home Graph runs

## Honest platform coverage

Optional host tests use conditional skips when their declared prerequisites are
unavailable. The test report must distinguish unexecuted checks from passes;
returning early from a test body must not pretend the fixture ran.

Supported-platform CI lanes must execute their fixtures. In particular,
`GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT=1` makes missing PTY or sandbox support
fail and requires both real exec-containment fixtures to complete. Conditional
skips cannot satisfy that proof. Keep network isolation, credential isolation,
fixture ownership, and cleanup active in every lane that runs.

Tests should assert observable outcomes rather than exact source spelling or
numeric performance quotas. Use controlled promises or barriers for ordering,
and release/drain them even when an assertion fails. Real production deadlines
remain tested as deadlines.

## Release validation

Release validation is broader than any single test run. `bun run validate`
(the `validate` job) covers documentation sync, contract and changelog
checks, the TypeScript build, type-level tests, API-surface and bundle-size
checks, package metadata, and packaging smoke tests, but it deliberately does
not execute the test suite itself. Test execution belongs to the
`platform-matrix` CI job, which builds once and then runs the Bun suite, the
React Native bundle scan, and the two Workers runtime lanes as separate matrix
legs against that same build. See
[Testing and Validation](./testing-and-validation.md) for the full command
and CI-gate reference.
