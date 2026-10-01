# Entry-file gzip report in validation

The consolidated `validate` command runs `bun run bundle:check` after the
workspace has been built. The historical command name remains compatible.
It reports gzipped bytes of individual built SDK entry files; imported
dependencies are excluded, so it does not measure consumer bundle size.

Missing, stale, malformed or exceeded historical references are advisory.
Do not add arbitrary thresholds to admit a new public export. The reporter
never changes `bundle-budgets.json`.

Missing built exports and unreadable or syntactically malformed package JSON remain errors.
`bun run bundle:check:strict` uses `--no-build` and also fails when build output
is absent. It has the same informational size policy as the ordinary command.

See [the reference-data documentation](../bundle-budgets.README.md).
Package contents, exports resolution, API, browser/RN compatibility and
packaged conformance remain required independently of this report.
