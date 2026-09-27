import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_EVENT_FIELD_SPECS, CONTRACT_EVENT_TYPES } from '../sdk/src/events/index.ts';
import type { FieldSpec } from '../sdk/src/events/contracts/shared.ts';
import type {
  OperatorContractManifest,
  OperatorEventContract,
  OperatorMethodContract,
  PeerContractManifest,
} from '../contracts/src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

// The artifacts are generated FROM these types by refresh-contract-artifacts.ts,
// so reading them back through the same declarations makes this generator fail to
// compile when the contract shape moves under it. Until this file was brought
// under `tsc`, every field access below was `any`.
const operatorContract = JSON.parse(
  readFileSync(resolve(SDK_ROOT, 'contracts/artifacts/operator-contract.json'), 'utf8'),
) as OperatorContractManifest;
const peerContract = JSON.parse(
  readFileSync(resolve(SDK_ROOT, 'contracts/artifacts/peer-contract.json'), 'utf8'),
) as PeerContractManifest;

/** One table row per field, nested object fields under their parent's path. */
function fieldRows(fields: readonly FieldSpec[], prefix: string): string[] {
  const rows: string[] = [];
  for (const field of fields) {
    const type = field.values ? `${field.kind}: ${field.values.map((value) => `\`${value}\``).join(', ')}` : field.kind;
    rows.push(`| \`${prefix}${field.key}\` | ${type} | ${field.optional === true ? 'optional' : 'yes'} |`);
    if (field.fields) rows.push(...fieldRows(field.fields, `${prefix}${field.key}${field.kind === 'object[]' ? '[]' : ''}.`));
  }
  return rows;
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeIfChanged(path: string, content: string): boolean {
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    throw new Error(`generated docs are out of sync: ${path}`);
  }
  ensureDir(path);
  writeFileSync(path, content);
  return true;
}

function stringify(value: unknown): string {
  return `\`${String(value)}\``;
}

function codeFence(value: string, language = 'json'): string {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function list(items: readonly unknown[] | undefined): string {
  if (!items || items.length === 0) return 'none';
  return items.map((item) => `\`${item}\``).join(', ');
}

function schemaBlock(schema: unknown): string {
  if (!schema) return 'none';
  return codeFence(JSON.stringify(schema, null, 2));
}

function byKey<T>(items: readonly T[], key: keyof T & string): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const raw = item[key];
    const group = typeof raw === 'string' ? raw : 'uncategorized';
    const existing = grouped.get(group) ?? [];
    existing.push(item);
    grouped.set(group, existing);
  }
  return Array.from(grouped.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function renderOperatorReference(): string {
  const lines: string[] = [];
  lines.push('# Operator API Reference');
  lines.push('');
  lines.push('Generated from the synced GoodVibes operator contract artifact.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Methods: \`${operatorContract.operator.methods.length}\``);
  lines.push(`- Events: \`${operatorContract.operator.events.length}\``);
  lines.push(`- Auth modes: ${list(operatorContract.auth.modes)}`);
  lines.push(`- HTTP status path: ${stringify(operatorContract.transports.http.statusPath)}`);
  lines.push(`- Methods catalog path: ${stringify(operatorContract.transports.http.methodsPath)}`);
  lines.push(`- Event catalog path: ${stringify(operatorContract.transports.http.eventsCatalogPath)}`);
  lines.push(`- SSE path: ${stringify(operatorContract.transports.sse.path)}`);
  lines.push(`- WebSocket path: ${stringify(operatorContract.transports.websocket.path)}`);
  lines.push('');
  lines.push('Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.');
  lines.push('');
  lines.push('## Authentication');
  lines.push('');
  lines.push(`- Login route: ${stringify(`${operatorContract.auth.login.method} ${operatorContract.auth.login.path}`)}`);
  lines.push(`- Current-auth route: ${stringify(`${operatorContract.auth.current.method} ${operatorContract.auth.current.path}`)}`);
  lines.push(`- Session cookie: ${stringify(operatorContract.auth.sessionCookie.name)} (${operatorContract.auth.sessionCookie.sameSite}, path ${operatorContract.auth.sessionCookie.path})`);
  lines.push(`- Bearer header: ${stringify(operatorContract.auth.bearer.header)}`);
  lines.push('');
  lines.push('## Realtime transports');
  lines.push('');
  lines.push('### WebSocket client frames');
  lines.push('');
  for (const frame of operatorContract.transports.websocket.clientFrames) {
    lines.push(`- ${stringify(frame.type)}${frame.fields?.length ? `: ${list(frame.fields)}` : ''}`);
  }
  lines.push('');
  lines.push('### WebSocket server frames');
  lines.push('');
  for (const frame of operatorContract.transports.websocket.serverFrames) {
    lines.push(`- ${stringify(frame.type)}${frame.fields?.length ? `: ${list(frame.fields)}` : ''}`);
  }
  lines.push('');
  lines.push('## Methods');
  lines.push('');
  for (const [category, methods] of byKey<OperatorMethodContract>(operatorContract.operator.methods, 'category')) {
    lines.push(`### ${category}`);
    lines.push('');
    for (const method of methods.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`#### ${stringify(method.id)}`);
      lines.push('');
      lines.push(method.description);
      lines.push('');
      lines.push(`- Title: ${stringify(method.title)}`);
      lines.push(`- Source: ${stringify(method.source)}`);
      lines.push(`- Access: ${stringify(method.access)}`);
      lines.push(`- Transport: ${list(method.transport)}`);
      lines.push(`- HTTP: ${method.http ? stringify(`${method.http.method} ${method.http.path}`) : 'none'}`);
      lines.push(`- Scopes: ${list(method.scopes)}`);
      lines.push(`- Emits events: ${list(method.events ?? [])}`);
      lines.push(`- Dangerous: ${method.dangerous ? '`yes`' : '`no`'}`);
      lines.push(`- Invokable: ${method.invokable === false ? '`no`' : '`yes`'}`);
      lines.push('');
      lines.push('##### Input schema');
      lines.push('');
      lines.push(schemaBlock(method.inputSchema));
      lines.push('');
      lines.push('##### Output schema');
      lines.push('');
      lines.push(schemaBlock(method.outputSchema));
      lines.push('');
    }
  }
  lines.push('## Events');
  lines.push('');
  for (const [category, events] of byKey<OperatorEventContract>(operatorContract.operator.events, 'category')) {
    lines.push(`### ${category}`);
    lines.push('');
    for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`#### ${stringify(event.id)}`);
      lines.push('');
      lines.push(event.description);
      lines.push('');
      lines.push(`- Title: ${stringify(event.title)}`);
      lines.push(`- Source: ${stringify(event.source)}`);
      lines.push(`- Transport: ${list(event.transport)}`);
      lines.push(`- Scopes: ${list(event.scopes)}`);
      lines.push(`- Domains: ${list(event.domains ?? [])}`);
      lines.push(`- Wire events: ${list(event.wireEvents ?? [])}`);
      lines.push('');
      lines.push('##### Payload schema');
      lines.push('');
      lines.push(schemaBlock(event.outputSchema));
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderPeerReference(): string {
  const lines: string[] = [];
  lines.push('# Peer API Reference');
  lines.push('');
  lines.push('Generated from the synced GoodVibes peer contract artifact.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Schema version: \`${peerContract.schemaVersion}\``);
  lines.push(`- Transport: ${stringify(peerContract.transport)}`);
  lines.push(`- Base path: ${stringify(peerContract.basePath)}`);
  lines.push(`- Peer kinds: ${list(peerContract.peerKinds)}`);
  lines.push(`- Work types: ${list(peerContract.workTypes)}`);
  lines.push(`- Work completion statuses: ${list(peerContract.workCompletionStatuses)}`);
  lines.push(`- Peer scopes: ${list(peerContract.scopes)}`);
  lines.push(`- Recommended heartbeat ms: \`${peerContract.recommendedHeartbeatMs}\``);
  lines.push(`- Recommended work-pull ms: \`${peerContract.recommendedWorkPullMs}\``);
  lines.push('');
  lines.push('Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.');
  lines.push('');
  lines.push('## Endpoints');
  lines.push('');
  for (const endpoint of [...peerContract.endpoints].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`### ${stringify(endpoint.id)}`);
    lines.push('');
    lines.push(endpoint.description);
    lines.push('');
    lines.push(`- HTTP: ${stringify(`${endpoint.method} ${endpoint.path}`)}`);
    lines.push(`- Auth: ${stringify(endpoint.auth)}`);
    lines.push(`- Required scope: ${endpoint.requiredScope ? stringify(endpoint.requiredScope) : 'none'}`);
    lines.push('');
    lines.push('#### Input schema');
    lines.push('');
    lines.push(schemaBlock(endpoint.inputSchema));
    lines.push('');
    lines.push('#### Output schema');
    lines.push('');
    lines.push(schemaBlock(endpoint.outputSchema));
    lines.push('');
  }
  lines.push('## Contract metadata');
  lines.push('');
  // `metadata` is a Record<string, unknown> in the contract type, so `note` is
  // `unknown`: the previous `?? 'none'` would have stringified a non-string
  // value into the published docs instead of falling back.
  const metadataNote = peerContract.metadata['note'];
  lines.push(typeof metadataNote === 'string' ? metadataNote : 'none');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderRuntimeEventReference(): string {
  const lines: string[] = [];
  const domains = new Map<string, OperatorEventContract[]>();
  for (const event of operatorContract.operator.events) {
    for (const domain of event.domains ?? []) {
      const existing: OperatorEventContract[] = domains.get(domain) ?? [];
      existing.push(event);
      domains.set(domain, existing);
    }
  }

  lines.push('# Runtime Events Reference');
  lines.push('');
  lines.push('Generated from the synced GoodVibes operator event contract artifact.');
  lines.push('');
  lines.push('## Transport endpoints');
  lines.push('');
  lines.push(`- SSE: ${stringify(operatorContract.transports.sse.path)}`);
  lines.push(`- WebSocket: ${stringify(operatorContract.transports.websocket.path)}`);
  lines.push(`- SSE query: ${stringify(`domains=${operatorContract.transports.sse.query.domains}`)}`);
  lines.push('');
  lines.push('Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.');
  lines.push('');
  lines.push('## Runtime domains');
  lines.push('');
  for (const [domain, events] of Array.from(domains.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${stringify(domain)}`);
    lines.push('');
    for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${stringify(event.id)}${event.wireEvents?.length ? ` -> ${list(event.wireEvents)}` : ''}`);
    }
    lines.push('');
    for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`#### ${stringify(event.id)} payload schema`);
      lines.push('');
      lines.push(schemaBlock(event.outputSchema));
      lines.push('');
    }
  }
  // The contract runner's named events, from the same field specs the runtime
  // validators check, so this section cannot drift from what is accepted.
  lines.push('## Named contract events');
  lines.push('');
  lines.push('The `contracts` domain carries one named event per step of a contract (docs/design/contract-runner.md section 8.1). Each field below is required unless marked optional.');
  lines.push('');
  for (const type of CONTRACT_EVENT_TYPES) {
    lines.push(`### \`${type}\``);
    lines.push('');
    lines.push('| Field | Type | Required |');
    lines.push('|-------|------|----------|');
    for (const row of fieldRows(CONTRACT_EVENT_FIELD_SPECS[type], '')) lines.push(row);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

let changed = false;
changed = writeIfChanged(resolve(SDK_ROOT, 'docs/reference-operator.md'), renderOperatorReference()) || changed;
changed = writeIfChanged(resolve(SDK_ROOT, 'docs/reference-peer.md'), renderPeerReference()) || changed;
changed = writeIfChanged(resolve(SDK_ROOT, 'docs/reference-runtime-events.md'), renderRuntimeEventReference()) || changed;

if (CHECK_ONLY) {
  console.log('generated API docs are in sync');
} else if (changed) {
  console.log('generated API docs updated');
} else {
  console.log('generated API docs already up to date');
}
