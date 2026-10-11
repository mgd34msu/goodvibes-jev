/** Versioned read-only CLI output identity. These are producer facts, not prose readings. */
export const WEBUI_BINDING_RESULT = {
  schema: 'goodvibes.daemon.webui-binding',
  schemaVersion: 1,
  source: 'configuration',
  endpoint: 'web',
} as const;

/** The exact invocation that emits WEBUI_BINDING_RESULT without changing settings. */
export const WEBUI_BINDING_QUERY = {
  args: ['status', '--json'],
  result: WEBUI_BINDING_RESULT,
} as const;
