# THE-62 C4: engine-owned natural-language scheduling

This is the bounded `/schedule add when` adoption. It does not claim a complete
THE-62 migration, live-provider calibration, autonomous job-execution admission,
or compiled TUI qualification.

## Ownership and retained scope

`@goodvibes-jev/engine/sdk/platform/automation::readNaturalLanguageSchedule`
owns semantic reading. One batched Jev port call reads the complete phrase,
source epoch clock, IANA timezone, exact literal-quantity candidates and their
UTF-16 offsets. The existing foundation date-parts pattern supplies the approach:
closed choices with unknown and qualification of every consumed part. There is
no English phrase, weekday or unit dictionary acting as a semantic fallback.

The former product `schedule-nl.ts` and its offline-parser-only tests are replaced
by engine and actual registered-command tests. Preserved families are hourly,
daily, weekly, weekdays, weekends, one named weekday, fixed N/unit intervals,
singular-unit intervals, relative N/unit delays, and a bare next time of day.
The old reader supported numeric literal quantities, plus implicit one for a
singular unit. It did not support spelled-out multi-unit amounts, arbitrary
calendar dates, compound intervals or phrase-selected timezone overrides. These
remain explicitly unsupported rather than approximated. Jev can recognize
paraphrases within the supported shapes and read spoken time-of-day parts.

Literal token scanning only offers candidates. Jev assigns their semantic role;
code does not decide that the first number is an amount. The complete-reading
question rejects negation, conflicting quantities, invalid times and any ignored
qualifier. Below-threshold or partial readings create no job. The registered
`automation.schedule` fixtures are discoverable through the existing calibration
registry walker. Scripted tests are plumbing evidence, not a live calibration pass.

The existing cron/every/at normalizers own grammar and ranges. Code assembles
positive safe durations and valid dates; one-shot next-time resolution uses the
scheduler's actual source-zone calendar, including DST gap/fold behavior. The
separate scheduler correction replaces process-local month/day/hour skipping
only when an explicit timezone is present. Its base/minute steps also use epoch
arithmetic so a process-local DST fold cannot rewind a requested-zone scan.
The finite 366-day bound and cron
field grammar are unchanged. Missing wall times use the next real occurrence;
a repeated wall time uses the first occurrence strictly after the captured clock.

## Live command and cancellation boundary

Both terminal dispatchers use existing `shellSplit` only for schedule/sched,
with a narrow incomplete/empty-quote guard. Empty words cannot shift prompt
text into the schedule slot. Invalid replacement submissions revoke an older
pending read. Other command tokenization is unchanged.
The owner phrase reaches Jev with internal whitespace and escaped quotes intact.
Typed cron/every/at never calls Jev.

Main owns `ScheduleReadingLifetime`. It captures the session, clock and local
zone before startup awaits, aborts on actual Escape/Ctrl+C, existing C2 session
replacement callbacks, new ordinary input, superseding schedule submissions and
shutdown. Startup rejections follow that same ownership fence; live operational
errors remain visible. Identical pending submissions share one admitted operation. Each
pre-effect await is followed by a live check; the final check immediately
precedes `manager.createJob`. Once that existing manager operation has entered,
this read owner does not pretend it can roll back persistence. Late completion
cannot repaint a cancelled/closed session. One-shot times that expired while Jev
was unavailable create no job.

The shared judgment port alone retries transport outages. There is no product
retry loop or human semantic approval prompt. Missing/permanently failed Jev
reports an operational error; unknown/unsupported/unqualified results create
zero jobs. A later valid invocation can recover. The concrete schedule echoed
before dispatch is the same object passed to createJob; timestamps use ISO UTC
and cron output includes the actual timezone and stagger.

## Focused evidence

- `packages/engine/test/automation-schedule-timezone.test.ts`: six baseline
  failures, then eight fixed zone/calendar cases; five isolated process-timezone
  controls additionally prove DST-fold monotonicity and the former cross-zone
  infinite loop. Existing schedule tests are retained.
- `packages/engine/test/automation-schedule-reading.test.ts`: supported shapes,
  exact arithmetic/provenance, unqualified parts, unknown, ranges, source clock,
  zone rollover, DST gap/fold and calibration discovery.
- `products/tui/src/test/input/schedule-reading.test.ts`: registered command,
  exact createJob payload/echo, actual terminal callers, typed grammar, malformed
  quotes, duplicates, lifecycle cancellation and the real shared retry port
  through controlled 503/recovery and signal-ignoring transport fixtures.

Source/test types, API-surface regeneration, full suites and compiled product
qualification remain separate required gates on the final composed source.
