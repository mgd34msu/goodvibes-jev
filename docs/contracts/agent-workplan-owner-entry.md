# Agent work-plan owner entry

The Agent workspace work-plan editors dispatch to the registered `/workplan` command.
`add`, local status changes (including `start` and `done`), removal and cleanup only
manage local todo records. They neither create native contracts nor run agents.
Local `done` is not native verified completion. Historical linked-agent ids and
receipts remain inspectable; this change does not migrate or rewrite them.

For native creation the owner supplies an original source JSON file containing
exactly `goal` (a string) and `criteria` (an ordered array of strings), then runs
`/work submit-file <JSON-path>` or `/workplan submit-file <JSON-path>`.
For example, an owner-authored file can contain:

```json
{"goal":"Prepare the requested report","criteria":["Include the requested sources"]}
```

The alias uses the existing native source-file validation, paired-principal
preflight, host/workspace binding and durable submission journal. It does not
construct source from todo title, owner/source labels, notes or model arguments.
Submission is not execution. The existing `/work` controls remain the separate
explicit execution surface. Unavailable, detached and unknown outcomes retain
their existing behavior. Inspect `/work submission-status` and recover the same
retained request with `/work submission-retry` (both also accept `/workplan`).
Never create a fresh request to resolve an uncertain previous submission.

`agent_work_plan` is a local-record tool. Its schema no longer offers
`dispatch_agents`; old calls receive an actionable refusal without invoking
agents or writing dispatch receipts. A model-written `explicitUserRequest`, even
with `confirm:true`, cannot become original owner authority. Existing destructive
local-record confirmation behavior is unchanged. Historical/import controls and
the native completion evaluator are unchanged.
