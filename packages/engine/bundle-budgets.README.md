# Entry-file gzip diagnostics

`bun run bundle:check` reports the gzipped bytes of each built SDK JavaScript
entry file. Imported dependencies are excluded. This is an entry-file report,
not a measurement of a consumer bundle or a shipping-size limit.

`bundle-budgets.json` is retained as optional historical reference data. Its
old values were calculated as `max(ceil(actual * 1.2), actual + 50)`; that rule
was inherited bookkeeping, not a consumer requirement. Missing, malformed,
stale or exceeded references are advisory. New exports and legitimate code
growth do not require adding or raising a threshold. The reporter does not
rewrite reference data.

The optional `./events.domains` list is also descriptive. Missing or stale
names produce an advisory; actual export resolution remains covered by the
package and API checks.

## Commands and real failures

```bash
bun run bundle:check         # builds if dist is absent; reports entry files
bun run bundle:check:strict  # never builds; absent build output is an error
```

Both commands still fail on missing built JavaScript export files, absent
build output when `--no-build` is requested, or unreadable or syntactically malformed package
JSON. Wildcard and non-JavaScript exports are excluded from this report.
The strict alias controls build behavior, not size-reference enforcement.

The report runs in `validate`. Package contents, public API and export
resolution, browser/React Native compatibility, and packaged-artifact
conformance retain their own required checks. A genuine consumer-size limit
would need a defined consumer entry, dependency bundling and an actual product
requirement; this report does not claim that proof.
