# Runtime Events Reference

Generated from the synced GoodVibes operator event contract artifact.

## Transport endpoints

- SSE: `/api/control-plane/events`
- WebSocket: `/api/control-plane/ws`
- SSE query: `domains=comma-separated runtime domains`

Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.

## Runtime domains

### `agents`

- `runtime.agents` -> `agents`

#### `runtime.agents` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `automation`

- `runtime.automation` -> `automation`

#### `runtime.automation` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `communication`

- `runtime.communication` -> `communication`

#### `runtime.communication` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `compaction`

- `runtime.compaction` -> `compaction`

#### `runtime.compaction` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `config`

- `runtime.config` -> `config`

#### `runtime.config` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `contracts`

- `runtime.contracts` -> `contracts`

#### `runtime.contracts` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `control-plane`

- `runtime.control-plane` -> `control-plane`

#### `runtime.control-plane` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `deliveries`

- `runtime.deliveries` -> `deliveries`

#### `runtime.deliveries` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `fleet`

- `runtime.fleet` -> `fleet`

#### `runtime.fleet` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `forensics`

- `runtime.forensics` -> `forensics`

#### `runtime.forensics` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `gate`

- `control.approval_update` -> `approval-update`
- `runtime.gate` -> `gate`

#### `control.approval_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "approval": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "callId": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        },
        "routeId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "claimed",
            "approved",
            "denied",
            "cancelled",
            "expired"
          ]
        },
        "request": {
          "type": "object",
          "properties": {
            "callId": {
              "type": "string"
            },
            "tool": {
              "type": "string"
            },
            "args": {
              "type": "object",
              "additionalProperties": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "object",
                    "additionalProperties": {}
                  },
                  {
                    "type": "array",
                    "items": {}
                  }
                ]
              }
            },
            "category": {
              "type": "string",
              "enum": [
                "read",
                "write",
                "execute",
                "delegate"
              ]
            },
            "analysis": {
              "type": "object",
              "properties": {
                "classification": {
                  "type": "string"
                },
                "riskLevel": {
                  "type": "string",
                  "enum": [
                    "low",
                    "medium",
                    "high",
                    "critical"
                  ]
                },
                "summary": {
                  "type": "string"
                },
                "reasons": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "target": {
                  "type": "string"
                },
                "targetKind": {
                  "type": "string",
                  "enum": [
                    "command",
                    "path",
                    "url",
                    "task",
                    "generic"
                  ]
                },
                "surface": {
                  "type": "string",
                  "enum": [
                    "filesystem",
                    "shell",
                    "network",
                    "orchestration",
                    "platform",
                    "generic"
                  ]
                },
                "blastRadius": {
                  "type": "string",
                  "enum": [
                    "local",
                    "project",
                    "external",
                    "delegated",
                    "platform"
                  ]
                },
                "sideEffects": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "host": {
                  "type": "string"
                }
              },
              "required": [
                "classification",
                "riskLevel",
                "summary",
                "reasons"
              ],
              "additionalProperties": false
            },
            "workingDirectory": {
              "type": "string"
            },
            "attribution": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "background-agent"
                      ]
                    },
                    "agentId": {
                      "type": "string"
                    },
                    "template": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "agentId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "mcp-server"
                      ]
                    },
                    "serverName": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "serverName"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "sandbox-escalation"
                      ]
                    },
                    "sandbox": {
                      "type": "string"
                    },
                    "escalations": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "sandbox",
                    "escalations"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "rememberOptions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tier": {
                    "type": "string",
                    "enum": [
                      "session",
                      "exact",
                      "command-class",
                      "path",
                      "tool"
                    ]
                  },
                  "label": {
                    "type": "string"
                  },
                  "detail": {
                    "type": "string"
                  }
                },
                "required": [
                  "tier",
                  "label",
                  "detail"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "callId",
            "tool",
            "args",
            "category",
            "analysis"
          ],
          "additionalProperties": false
        },
        "createdAt": {
          "type": "number"
        },
        "updatedAt": {
          "type": "number"
        },
        "claimedBy": {
          "type": "string"
        },
        "claimedAt": {
          "type": "number"
        },
        "resolvedAt": {
          "type": "number"
        },
        "resolvedBy": {
          "type": "string"
        },
        "decision": {
          "type": "object",
          "properties": {
            "approved": {
              "type": "boolean"
            },
            "remember": {
              "type": "boolean"
            },
            "rememberTier": {
              "type": "string",
              "enum": [
                "session",
                "exact",
                "command-class",
                "path",
                "tool"
              ]
            },
            "reason": {
              "type": "string"
            },
            "modifiedArgs": {
              "type": "object",
              "additionalProperties": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "object",
                    "additionalProperties": {}
                  },
                  {
                    "type": "array",
                    "items": {}
                  }
                ]
              }
            },
            "disposition": {
              "type": "string",
              "enum": [
                "approved",
                "denied",
                "amended",
                "cancelled",
                "expired",
                "remembered"
              ]
            }
          },
          "required": [
            "approved"
          ],
          "additionalProperties": false
        },
        "fixSessionId": {
          "type": "string"
        },
        "fixSessionError": {
          "type": "string"
        },
        "expiresAt": {
          "type": "number"
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": {}
              },
              {
                "type": "array",
                "items": {}
              }
            ]
          }
        },
        "audit": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "action": {
                "type": "string",
                "enum": [
                  "created",
                  "claimed",
                  "approved",
                  "denied",
                  "cancelled",
                  "expired",
                  "updated"
                ]
              },
              "actor": {
                "type": "string"
              },
              "actorSurface": {
                "type": "string"
              },
              "createdAt": {
                "type": "number"
              },
              "note": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "action",
              "actor",
              "createdAt"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "id",
        "callId",
        "status",
        "request",
        "createdAt",
        "updatedAt",
        "metadata",
        "audit"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    }
  },
  "required": [
    "approval",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `runtime.gate` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `knowledge`

- `runtime.knowledge` -> `knowledge`

#### `runtime.knowledge` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `mcp`

- `runtime.mcp` -> `mcp`

#### `runtime.mcp` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `ops`

- `runtime.ops` -> `ops`

#### `runtime.ops` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `planner`

- `runtime.planner` -> `planner`

#### `runtime.planner` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `plugins`

- `runtime.plugins` -> `plugins`

#### `runtime.plugins` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `providers`

- `runtime.providers` -> `providers`

#### `runtime.providers` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `routes`

- `runtime.routes` -> `routes`

#### `runtime.routes` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `security`

- `runtime.security` -> `security`

#### `runtime.security` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `session`

- `control.hosted_session_update` -> `hosted-session-update`
- `control.session_update` -> `session-update`
- `runtime.session` -> `session`

#### `control.hosted_session_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "event": {
      "type": "string",
      "enum": [
        "hosted-session-created",
        "hosted-session-attached",
        "hosted-session-detached",
        "hosted-session-turn-started",
        "hosted-session-turn-ended",
        "hosted-session-terminated",
        "hosted-session-restored",
        "hosted-session-contract-started",
        "hosted-session-contract-notice"
      ]
    },
    "session": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceRoot": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "idle",
            "running",
            "terminated"
          ]
        },
        "detachPolicy": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "kill",
                "survive"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "effectiveDetachPolicy": {
          "type": "string",
          "enum": [
            "kill",
            "survive"
          ]
        },
        "attachedClients": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "providerId": {
          "type": "string"
        },
        "modelId": {
          "type": "string"
        },
        "createdAt": {
          "type": "number"
        },
        "updatedAt": {
          "type": "number"
        },
        "turnCount": {
          "type": "number"
        },
        "messageCount": {
          "type": "number"
        },
        "lastTurnAt": {
          "type": "number"
        },
        "terminatedAt": {
          "type": "number"
        },
        "terminatedReason": {
          "type": "string"
        },
        "restoredFromDisk": {
          "type": "boolean"
        },
        "contractIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "workspaceRoot",
        "title",
        "status",
        "detachPolicy",
        "effectiveDetachPolicy",
        "attachedClients",
        "createdAt",
        "updatedAt",
        "turnCount",
        "messageCount",
        "restoredFromDisk",
        "contractIds"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    },
    "clientId": {
      "type": "string"
    },
    "detail": {
      "type": "string"
    }
  },
  "required": [
    "event",
    "session",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `control.session_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "event": {
      "type": "string",
      "enum": [
        "session-created",
        "session-closed",
        "session-deleted",
        "session-reopened",
        "session-agent-bound",
        "session-agent-completed",
        "session-message-appended",
        "session-message-forwarded",
        "session-route-attached",
        "session-detached",
        "session-input-queued",
        "session-input-queued-for-surface",
        "session-input-delivered",
        "session-input-spawned",
        "session-input-completed",
        "session-input-failed",
        "session-input-rejected",
        "session-input-cancelled",
        "session-follow-up-queued",
        "session-follow-up-spawned"
      ]
    },
    "payload": {
      "type": "object",
      "additionalProperties": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "number"
          },
          {
            "type": "boolean"
          },
          {
            "type": "null"
          },
          {},
          {
            "type": "array",
            "items": {}
          }
        ]
      }
    },
    "createdAt": {
      "type": "number"
    }
  },
  "required": [
    "event",
    "payload",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `runtime.session` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `surfaces`

- `runtime.surfaces` -> `surfaces`

#### `runtime.surfaces` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `tasks`

- `runtime.tasks` -> `tasks`

#### `runtime.tasks` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `tools`

- `runtime.tools` -> `tools`

#### `runtime.tools` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `transport`

- `runtime.transport` -> `transport`

#### `runtime.transport` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `turn`

- `runtime.turn` -> `turn`

#### `runtime.turn` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `ui`

- `runtime.ui` -> `ui`

#### `runtime.ui` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `watchers`

- `runtime.watchers` -> `watchers`

#### `runtime.watchers` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `workspace`

- `runtime.workspace` -> `workspace`

#### `runtime.workspace` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

## Named contract events

The `contracts` domain carries one named event per step of a contract (docs/design/contract-runner.md section 8.1). Each field below is required unless marked optional.

### `CONTRACT_CREATED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `sessionId` | string | yes |
| `origin` | enum: `turn`, `agent-tool`, `cli`, `hosted`, `external`, `proposal` | yes |
| `ask` | string | yes |
| `ownerAgentId` | string | yes |

### `CONTRACT_STATUS_CHANGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `from` | enum: `queued`, `shaping`, `planning`, `checking-plan`, `running`, `judging`, `fixing`, `committing`, `awaiting-owner`, `passed`, `failed`, `cancelled` | yes |
| `to` | enum: `queued`, `shaping`, `planning`, `checking-plan`, `running`, `judging`, `fixing`, `committing`, `awaiting-owner`, `passed`, `failed`, `cancelled` | yes |

### `CONTRACT_SHAPED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `forbidsDelegation` | object | yes |
| `forbidsDelegation.verdict` | enum: `yes`, `no`, `uncertain` | yes |
| `forbidsDelegation.probability` | number | yes |
| `forbidsDelegation.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `requestsParallelAgents` | object | yes |
| `requestsParallelAgents.verdict` | enum: `yes`, `no`, `uncertain` | yes |
| `requestsParallelAgents.probability` | number | yes |
| `requestsParallelAgents.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `forbidsWriting` | object | yes |
| `forbidsWriting.verdict` | enum: `yes`, `no`, `uncertain` | yes |
| `forbidsWriting.probability` | number | yes |
| `forbidsWriting.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `asksForAttempts` | object | yes |
| `asksForAttempts.verdict` | enum: `yes`, `no`, `uncertain` | yes |
| `asksForAttempts.probability` | number | yes |
| `asksForAttempts.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `decisionIds` | string[] | yes |

### `CONTRACT_PLANNED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `goal` | string | yes |
| `criteria` | object[] | yes |
| `criteria[].id` | string | yes |
| `criteria[].text` | string | yes |
| `criteria[].origin` | enum: `stated`, `derived`, `integration`, `fix`, `owner` | yes |
| `criteria[].quote` | string | optional |
| `criteria[].serves` | string[] | yes |
| `criteria[].disposition` | enum: `judged`, `excluded`, `met-by-structure` | yes |
| `criteria[].dispositionReason` | string | optional |
| `groups` | object[] | yes |
| `groups[].id` | string | yes |
| `groups[].title` | string | yes |
| `groups[].kind` | enum: `work`, `fix`, `integration` | yes |
| `groups[].dependsOn` | string[] | yes |
| `groups[].unitIds` | string[] | yes |
| `units` | object[] | yes |
| `units[].id` | string | yes |
| `units[].groupId` | string | yes |
| `units[].title` | string | yes |
| `units[].role` | enum: `implement`, `research`, `design`, `integration` | yes |
| `units[].dependsOn` | string[] | yes |
| `units[].attempts` | number | yes |
| `repair` | number | yes |

### `CONTRACT_PLAN_CHECKED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `check` | enum: `structure`, `criterion-trace`, `plan-coverage`, `criterion-shape`, `unit-shape` | yes |
| `targetId` | string | optional |
| `passed` | boolean | yes |
| `problems` | object[] | yes |
| `problems[].code` | string | yes |
| `problems[].targetId` | string | optional |
| `problems[].message` | string | yes |
| `decisionIds` | string[] | yes |

### `CONTRACT_GROUP_STATUS_CHANGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `groupId` | string | yes |
| `from` | enum: `pending`, `blocked`, `running`, `judging`, `fixing`, `awaiting-owner`, `passed`, `failed`, `cancelled` | yes |
| `to` | enum: `pending`, `blocked`, `running`, `judging`, `fixing`, `awaiting-owner`, `passed`, `failed`, `cancelled` | yes |

### `CONTRACT_UNIT_STATUS_CHANGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `groupId` | string | yes |
| `unitId` | string | yes |
| `from` | enum: `pending`, `blocked`, `running`, `checking`, `held`, `nudged`, `fixing`, `awaiting-owner`, `held-merge`, `passed`, `failed`, `cancelled` | yes |
| `to` | enum: `pending`, `blocked`, `running`, `checking`, `held`, `nudged`, `fixing`, `awaiting-owner`, `held-merge`, `passed`, `failed`, `cancelled` | yes |
| `agentId` | string | optional |

### `CONTRACT_UNIT_SPAWNED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `agentId` | string | yes |
| `route` | object | yes |
| `route.model` | string | yes |
| `route.provider` | string | yes |
| `route.reasoningEffort` | string | optional |
| `route.reason` | string | yes |
| `purpose` | enum: `unit`, `fresh-unit`, `transport-retry`, `silence-retry`, `resume` | yes |

### `CONTRACT_CHECKED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `scope` | enum: `unit`, `group`, `deliverable` | yes |
| `targetId` | string | yes |
| `checkId` | string | yes |
| `trigger` | enum: `turn-end`, `completion`, `agent-failed`, `fix-passed`, `resume`, `owner-amend` | yes |
| `result` | enum: `pass`, `nudge`, `await-owner`, `stall`, `recorded` | yes |
| `criteria` | object[] | yes |
| `criteria[].criterionId` | string | yes |
| `criteria[].verdict` | enum: `met`, `unmet`, `unshown` | yes |
| `criteria[].probabilityUnmet` | number | yes |
| `criteria[].outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `goal` | object | yes |
| `goal.verdict` | enum: `met`, `unmet`, `unshown` | yes |
| `goal.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `quality` | object[] | yes |
| `quality[].item` | enum: `placeholder`, `tests_weakened`, `breaks_existing`, `out_of_scope`, `hidden_failure`, `unsupported_claims` | yes |
| `quality[].verdict` | enum: `yes`, `no`, `uncertain` | yes |
| `quality[].outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `gates` | object[] | yes |
| `gates[].gate` | string | yes |
| `gates[].passed` | boolean | yes |
| `gates[].skipped` | boolean | yes |
| `claims` | enum: `files_verified`, `git_corroborated`, `verified_empty`, `unverifiable_no_claims`, `unverified` | optional |
| `decisionIds` | string[] | yes |

### `CONTRACT_NUDGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `nudgeId` | string | yes |
| `checkId` | string | yes |
| `kinds` | enum[]: `unmet`, `unshown`, `regression`, `quality`, `gate`, `claims` | yes |
| `criterionIds` | string[] | yes |
| `delivery` | enum: `hold`, `bus`, `wake` | yes |
| `agentId` | string | yes |

### `CONTRACT_NUDGE_CONSUMED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `nudgeId` | string | yes |
| `agentId` | string | yes |
| `turn` | number | optional |

### `CONTRACT_CRITERION_REGRESSED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `criterionId` | string | yes |
| `metAtCheckId` | string | yes |
| `checkId` | string | yes |

### `CONTRACT_STALLED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `scope` | enum: `unit`, `group`, `deliverable` | yes |
| `targetId` | string | yes |
| `route` | enum: `split`, `fresh`, `owner` | yes |
| `unmetCriterionIds` | string[] | yes |
| `reason` | string | yes |
| `decisionId` | string | optional |

### `CONTRACT_FIX_PLANNED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `scope` | enum: `unit`, `group`, `deliverable` | yes |
| `targetId` | string | yes |
| `groupId` | string | yes |
| `unitIds` | string[] | yes |
| `round` | number | yes |

### `CONTRACT_ESCALATED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `escalationId` | string | yes |
| `scope` | enum: `plan`, `unit`, `group`, `deliverable`, `shape` | yes |
| `targetId` | string | yes |
| `reason` | enum: `plan-unresolved`, `stalled`, `unsettled`, `fix-rounds-exhausted`, `writing-unclear`, `attempts-undecided`, `owner-decision-needed` | yes |
| `question` | string | yes |
| `unmetCriterionIds` | string[] | yes |

### `CONTRACT_OWNER_REPLIED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `escalationId` | string | yes |
| `reading` | enum: `approve`, `reject`, `amend`, `unclear` | yes |
| `outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `action` | string | yes |

### `CONTRACT_GATE_RESULT`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `targetId` | string | yes |
| `gate` | string | yes |
| `passed` | boolean | yes |
| `skipped` | boolean | yes |
| `durationMs` | number | yes |

### `CONTRACT_UNIT_SILENT`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `agentId` | string | yes |
| `silentMs` | number | yes |
| `action` | enum: `retried`, `failed` | yes |

### `CONTRACT_MERGE_CONFLICT`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `branch` | string | yes |
| `path` | string | yes |
| `files` | string[] | yes |

### `CONTRACT_ATTEMPTS_SELECTED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `candidateIds` | string[] | yes |
| `chosen` | string|null | yes |
| `outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `decisionId` | string | optional |

### `CONTRACT_COMMITTED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `status` | enum: `committed`, `applied`, `skipped`, `failed` | yes |
| `hash` | string | optional |
| `note` | string | yes |

### `CONTRACT_PASSED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `criteriaMet` | number | yes |
| `criteriaJudged` | number | yes |
| `excluded` | number | yes |
| `nudges` | number | yes |

### `CONTRACT_FAILED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `reason` | string | yes |
| `failureKind` | enum: `transport`, `max_turns`, `planning`, `budget`, `owner-rejected`, `judgment-unavailable`, `zombie`, `other` | yes |
| `membersSettled` | boolean | yes |
| `turnLimit` | number | optional |
| `turnLimitSource` | enum: `default`, `spawn-override`, `policy-bound` | optional |

### `CONTRACT_CANCELLED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `reason` | string | yes |
| `filesModified` | number | yes |

### `CONTRACT_SPAWN_GUARD_TRIGGERED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | optional |
| `agentId` | string | yes |
| `depth` | number | yes |
| `activeAgents` | number | yes |
| `reason` | string | yes |

