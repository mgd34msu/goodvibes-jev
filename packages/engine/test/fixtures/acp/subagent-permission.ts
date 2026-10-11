/** Synthetic stdio peer. No providers, environment reads or credentials. */
const report = process.argv[2]!;
let promptId: unknown;
const send = (message: unknown) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
async function handle(message: Record<string, unknown>) {
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'subprocess-session' } });
  else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ jsonrpc: '2.0', id: 'permission:wire-original', method: 'session/request_permission', params: {
      sessionId: 'subprocess-session', toolCall: { toolCallId: 'tool:wire-original', title: 'write project file', kind: 'edit', rawInput: { path: 'project.txt' } },
      options: [{ optionId: 'wire-deny', name: 'Reject', kind: 'reject_once' }, { optionId: 'wire-allow', name: 'Allow', kind: 'allow_once' }],
    } });
  } else if (message.id === 'permission:wire-original') {
    await Bun.write(report, JSON.stringify(message));
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
let buffered = '';
for await (const bytes of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(bytes);
  for (;;) {
    const at = buffered.indexOf('\n'); if (at < 0) break;
    const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
    if (line.trim()) await handle(JSON.parse(line) as Record<string, unknown>);
  }
}
