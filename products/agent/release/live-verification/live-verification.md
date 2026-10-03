# GoodVibes Agent Live Verification

Generated: 2026-09-30T06:59:29.668Z
Home: `[goodvibes-home]`
Binary: `[agent-binary]`
Connected host: `http://127.0.0.1:3421`

| Status | Count |
|---|---:|
| pass | 19 |
| warn | 0 |
| fail | 0 |
| skip | 0 |

| Check | Status | Summary |
|---|---|---|
| Verification inventory ledger | pass | 99.6% local verification signal across 994 inventory items. |
| Compiled GoodVibes Agent CLI binary | pass | Found [agent-binary]. |
| Agent CLI version command | pass | Agent CLI version returned successfully. |
| Agent CLI status JSON command | pass | Agent CLI status returned parseable JSON. |
| Agent CLI compatibility JSON command | pass | Agent CLI compatibility returned parseable JSON. |
| Agent Knowledge CLI status command | pass | Agent Knowledge status returned parseable JSON. |
| Agent CLI providers command | pass | Provider inventory rendered successfully. |
| CLI doctor command | pass | Doctor completed; 2 operator-configuration risk advisory(ies) noted (intentional trust posture, not a release defect). |
| Authenticated connected-host /status | pass | /status returned 200 with parseable JSON. |
| Authenticated connected-host /api/health | pass | Health overall=healthy. |
| OpenAI-compatible /v1/models route | pass | /v1/models returned 2007 model(s). |
| Agent Knowledge isolated /status | pass | Agent Knowledge status route returned parseable isolated JSON. |
| Agent Knowledge isolated ask | pass | Agent Knowledge ask stayed on the isolated Agent route. |
| Agent Knowledge isolated search | pass | Agent Knowledge search stayed on the isolated Agent route. |
| Agent Knowledge isolated sources list | pass | Agent Knowledge isolated sources list stayed on the isolated Agent route. |
| Agent Knowledge isolated nodes list | pass | Agent Knowledge isolated nodes list stayed on the isolated Agent route. |
| Agent Knowledge isolated issues list | pass | Agent Knowledge isolated issues list stayed on the isolated Agent route. |
| Agent Knowledge isolated map | pass | Agent Knowledge isolated map stayed on the isolated Agent route. |
| Agent Knowledge isolated connectors list | pass | Agent Knowledge isolated connectors list stayed on the isolated Agent route. |

## Details

### Verification inventory ledger

```text
84% local behavior verified; 125 item(s) require external outcomes.
```

### Agent CLI version command

```text
goodvibes-agent 2.1.0
```

### Agent CLI status JSON command

```text
Status JSON command completed; provider/model identifiers omitted from release artifact.
```

### Agent CLI compatibility JSON command

```text
{
  "ok": true,
  "packageVersion": "2.1.0",
  "connectedHost": {
    "baseUrl": "http://127.0.0.1:3421",
    "status": 200,
    "reachable": true,
    "compatible": true
  },
  "auth": {
    "tokenPresent": true,
    "tokenPath": "env:GOODVIBES_CONNECTED_HOST_TOKEN"
  },
  "agentKnowledge": {
    "route": "/api/goodvibes-agent/knowledge/status",
    "ready": true,
    "kind": "ok"
  }
}
```

### Agent Knowledge CLI status command

```text
{
  "ok": true,
  "kind": "agentKnowledge.status",
  "route": "/api/goodvibes-agent/knowledge/status",
  "data": {
    "ready": true,
    "storagePath": "[goodvibes-home]/tui/knowledge-agent.sqlite",
    "sourceCount": 0,
    "nodeCount": 4,
    "edgeCount": 3,
    "issueCount": 0,
    "extractionCount": 0,
    "jobRunCount": 500,
    "refinementTaskCount": 0,
    "usageCount": 7,
    "candidateCount": 1,
    "reportCount": 117,
    "scheduleCount": 3,
    "note": "Structured knowledge uses SQL-backed sources, nodes, edges, issues, extractions, and job runs. Markdown is an optional projection, not the source of truth."
  }
}
```

### Agent CLI providers command

```text
Provider inventory command completed; provider names and credential posture omitted from release artifact.
```

### CLI doctor command

```text
Doctor command completed without findings; provider/model identifiers and credential posture omitted from release artifact.
```

### Authenticated connected-host /status

```text
{"status":"running","version":"1.28.25","buildVersion":"1.28.25","platformVersion":"2.0.23","cluster":{"enabled":false,"role":"master","nodeId":"59a6a335-d62a-486d-a4a0-7e64e3ff4944","version":"1.28.25","uptimeMs":0,"consumersRunning":true,"heldSurfaceCount":7,"signed":false,"surfaces":[{"surfaceId":"6e9bf353efb32e17c43b5881204f9a20","label":"inbox:6e9bf353","kind":"inbox","role":"master","holderNodeId":"59a6a335-d62a-486d-a4a0-7e64e3ff4944","consuming":true,"lastHolderHeartbeatAt":null},{"surfaceId":"89c112b2dc732cef71afa8c9df8fdc6f","label":"inbox:89c112b2","kind":"inbox","role":"master","holderNodeId":"59a6a335-d62a-486d-a4a0-7e64e3ff4944","consuming":true,"lastHolderHeartbeatAt":null},{"surfaceId":"93b73cdc72c58e86297104412a7769bb","label":"inbox:93b73cdc","kind":"inbox","role":"master","holderNodeId":"59a6a335-d62a-486d-a4a0-7e64e3ff4944","consuming":true,"lastHolder... [truncated]
```

### Authenticated connected-host /api/health

```text
{"overall":"healthy","degradedDomains":[],"providerProblems":[],"mcpProblems":{"degraded":[],"quarantined":[]},"integrationProblems":[],"network":{"controlPlane":{"surface":"controlPlane","host":"0.0.0.0","port":3421,"mode":"off","scheme":"http","trustProxy":false,"usingDefaultPaths":false,"ready":true,"errors":[]},"httpListener":{"surface":"httpListener","host":"0.0.0.0","port":3422,"mode":"off","scheme":"http","trustProxy":false,"usingDefaultPaths":false,"ready":true,"errors":[]},"outbound":{"mode":"bundled","allowInsecureLocalhost":false,"customCaEntryCount":0,"effectiveCaStrategy":"bun-default","errors":[]}}}
```

### OpenAI-compatible /v1/models route

```text
/v1/models returned 2007 model(s); model identifiers omitted from release artifact.
```

### Agent Knowledge isolated /status

```text
{"ready":true,"storagePath":"[goodvibes-home]/tui/knowledge-agent.sqlite","sourceCount":0,"nodeCount":4,"edgeCount":3,"issueCount":0,"extractionCount":0,"jobRunCount":500,"refinementTaskCount":0,"usageCount":7,"candidateCount":1,"reportCount":117,"scheduleCount":3,"note":"Structured knowledge uses SQL-backed sources, nodes, edges, issues, extractions, and job runs. Markdown is an optional projection, not the source of truth."}
```

### Agent Knowledge isolated ask

```text
{"ok":true,"spaceId":"default","query":"What is GoodVibes Agent?","answer":{"text":"No knowledge matched \"What is GoodVibes Agent?\".","mode":"concise","confidence":0,"sources":[],"linkedObjects":[],"facts":[],"gaps":[],"synthesized":false},"results":[]}
```

### Agent Knowledge isolated search

```text
{"results":[{"kind":"node","id":"memory-mem_ms2bfhdt_092d1166","score":25,"reason":"matched task token \"is\"","node":{"id":"memory-mem_ms2bfhdt_092d1166","kind":"memory","slug":"mem-ms2bfhdt-092d1166","title":"Standing authorization to use the assistant-dedicated email account when reasonably needed for user tasks.","summary":"The user authorizes proactive use of the dedicated email account for task-integral website/forum sign-ups, routine account verification, and sending/receiving email without asking each time. Still pause for purchases or paid trials, contracts or consequential legal terms, high-impact or sensitive accounts, disclosure of sensitive data, destructive/irreversible actions, or any mandatory platform confirmation. Never expose credentials, recovery links, or verification codes.","aliases":["email","standing-authorization","autonomy"],"status":"active","c... [truncated]
```

### Agent Knowledge isolated sources list

```text
{"sources":[]}
```

### Agent Knowledge isolated nodes list

```text
{"nodes":[{"id":"node-56c8e2cc","kind":"topic","slug":"standing-authorization","title":"standing-authorization","summary":"Topic tag standing-authorization.","aliases":["standing-authorization"],"status":"active","confidence":70,"metadata":{"tag":"standing-authorization","knowledgeSpaceId":"default","namespace":"default","reviewProvenance":{"state":"auto-accepted","reason":"auto-accepted: confidence 70 >= auto-accept threshold 40","decidedAt":1785104923908,"threshold":40}},"createdAt":1785104923908,"updatedAt":1785104923908},{"id":"node-f02b3f1c","kind":"topic","slug":"autonomy","title":"autonomy","summary":"Topic tag autonomy.","aliases":["autonomy"],"status":"active","confidence":70,"metadata":{"tag":"autonomy","knowledgeSpaceId":"default","namespace":"default","reviewProvenance":{"state":"auto-accepted","reason":"auto-accepted: confidence 70 >= auto-accept threshold 40... [truncated]
```

### Agent Knowledge isolated issues list

```text
{"issues":[]}
```

### Agent Knowledge isolated map

```text
{"ok":true,"title":"Knowledge Map","generatedAt":1790751569664,"width":1280,"height":920,"nodeCount":4,"edgeCount":3,"totalNodeCount":4,"totalEdgeCount":3,"facets":{"recordKinds":[{"value":"node","count":4}],"nodeKinds":[{"value":"topic","count":3},{"value":"memory","count":1}],"sourceTypes":[],"sourceStatuses":[],"nodeStatuses":[{"value":"active","count":4}],"issueCodes":[],"issueStatuses":[],"issueSeverities":[],"edgeRelations":[{"value":"memory_tagged_with","count":3}],"tags":[]},"nodes":[{"id":"node-f02b3f1c","recordKind":"node","kind":"topic","title":"autonomy","summary":"Topic tag autonomy.","x":720,"y":277,"radius":23,"metadata":{"tag":"autonomy","knowledgeSpaceId":"default","namespace":"default","reviewProvenance":{"state":"auto-accepted","reason":"auto-accepted: confidence 70 >= auto-accept threshold 40","decidedAt":1785104923908,"threshold":40}}},{"id":"node-a21... [truncated]
```

### Agent Knowledge isolated connectors list

```text
{"connectors":[{"id":"bookmark","displayName":"Bookmarks Import","version":"1","description":"Parse bookmark exports or bookmark-like JSON into bookmark seeds.","sourceType":"bookmark","capabilities":["bookmark-export","netscape-html","bookmark-json"],"inputSchema":{"type":"string","description":"Bookmark export content such as Netscape bookmark HTML or bookmark-like JSON."},"examples":["<!DOCTYPE NETSCAPE-Bookmark-file-1>..."],"metadata":{"accepts":["inline-content","file-content"],"preferredContentType":"text/html","transportHints":["content","path"]},"setup":{"version":"1","summary":"Imports bookmark export files or bookmark-like JSON payloads.","steps":["Export bookmarks from a browser as Netscape-style HTML or supply bookmark-like JSON.","Send the content directly or provide a file path to the ingest endpoint."],"fields":[{"key":"content","label":"Bookmark Content","... [truncated]
```

Result: PASS
