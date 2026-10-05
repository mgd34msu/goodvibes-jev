import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { WEBUI_BUILTIN_COMMANDS, WEBUI_COMMAND_CATALOG_VERSION } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import { runBrowserJudgment } from './goodvibes';
import { getCommandRegistryRevision, getCommands, type CommandDef } from './commands';
import { randomUuid } from './uuid';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';

type PaletteRequest = BrowserJudgmentRequest<'webui.palette.command-rank'>;
type PaletteResponse = Extract<OperatorMethodOutput<'judgment.battery.run'>, { battery: 'webui.palette.command-rank' }>;
type Settled = Extract<PaletteResponse, { status: 'settled' }>;
type Held = Extract<PaletteResponse, { status: 'held' }>;
export type CommandSearchResult =
  | { readonly status: 'ready'; readonly commands: readonly CommandDef[]; readonly reading: Settled; readonly isCurrent: () => boolean }
  | { readonly status: 'held'; readonly reason: 'uncertain'; readonly reading: Held }
  | { readonly status: 'held'; readonly reason: 'permission' | 'source' | 'unsupported' }
  | { readonly status: 'unavailable'; readonly reason: 'unavailable' | 'invalid-response' | 'aborted' | 'stale' };
export interface CommandSearchSnapshot {
  readonly revision: number;
  readonly commands: readonly CommandDef[];
}

const builtins = new Set<string>(WEBUI_BUILTIN_COMMANDS.map(({ id }) => id));
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unavailable = (reason: Extract<CommandSearchResult, { status: 'unavailable' }>['reason']): CommandSearchResult => ({ status: 'unavailable', reason });

/** Validate the actual wire contract and bind every reading to this request's opaque index. */
export function readCommandRankResponse(request: PaletteRequest, raw: unknown): PaletteResponse | undefined {
  const result = object(raw);
  if (result?.protocolVersion !== 1 || result.batteryVersion !== 1 || result.requestId !== request.requestId
    || result.battery !== request.battery || (result.status !== 'settled' && result.status !== 'held')) return undefined;
  const settled = result.status === 'settled';
  if (!keys(result, ['protocolVersion', 'batteryVersion', 'requestId', 'battery', 'status', settled ? 'value' : 'reason', 'readings', 'outcome', 'evidence'])) return undefined;
  const readings = object(result.readings);
  const count = request.input.candidates.length;
  if (!readings || count < 1 || count > 64 || !keys(readings, Array.from({ length: count }, (_, index) => `candidate_${index}`))) return undefined;
  let strongest = 0;
  for (const reading of Object.values(readings)) {
    const r = object(reading);
    if (!r || !keys(r, ['kind', 'probability', 'verdict', 'outcome']) || r.kind !== 'yes-no' || !probability(r.probability)
      || typeof r.verdict !== 'string' || !['yes', 'no', 'uncertain'].includes(r.verdict)
      || typeof r.outcome !== 'string' || !['act', 'confirm', 'escalate'].includes(r.outcome)) return undefined;
    if (r.verdict === 'uncertain' && r.outcome === 'act') return undefined;
    strongest = Math.max(strongest, r.outcome === 'escalate' ? 2 : r.outcome === 'confirm' ? 1 : 0);
  }
  if (!Array.isArray(result.evidence) || result.evidence.length !== count) return undefined;
  const decisions = new Set<string>();
  for (const item of result.evidence) {
    const evidence = object(item);
    const usage = object(evidence?.usage);
    if (!evidence || !keys(evidence, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs'])
      || !nonempty(evidence.decisionId) || decisions.has(evidence.decisionId) || !nonempty(evidence.model) || !nonempty(evidence.requestedModel)
      || !nonnegative(evidence.latencyMs) || !usage || !keys(usage, ['inputTokens', 'outputTokens'])
      || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) return undefined;
    decisions.add(evidence.decisionId);
  }
  if (!settled) {
    if (result.reason !== 'uncertain' || (result.outcome !== 'confirm' && result.outcome !== 'escalate')
      || (strongest === 2 && result.outcome !== 'escalate')) return undefined;
    return raw as Held;
  }
  if (result.outcome !== 'act' || strongest !== 0) return undefined;
  const value = object(result.value);
  if (!value || !keys(value, ['registryVersion', 'accepted', 'rejected']) || value.registryVersion !== request.input.registryVersion
    || !Array.isArray(value.accepted) || !Array.isArray(value.rejected) || value.accepted.length + value.rejected.length !== count) return undefined;
  const seen = new Set<number>();
  const index = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate < count && !seen.has(candidate);
  let previousProbability = Infinity;
  let previousIndex = -1;
  for (const item of value.accepted) {
    const accepted = object(item);
    if (!accepted || !keys(accepted, ['candidateIndex', 'probability']) || !index(accepted.candidateIndex) || !probability(accepted.probability)) return undefined;
    const reading = object(readings[`candidate_${accepted.candidateIndex}`]);
    if (reading?.verdict !== 'yes' || reading.probability !== accepted.probability || accepted.probability > previousProbability
      || (accepted.probability === previousProbability && accepted.candidateIndex <= previousIndex)) return undefined;
    previousProbability = accepted.probability; previousIndex = accepted.candidateIndex;
    seen.add(accepted.candidateIndex);
  }
  for (const candidate of value.rejected) {
    if (!index(candidate) || object(readings[`candidate_${candidate}`])?.verdict !== 'no') return undefined;
    seen.add(candidate);
  }
  return seen.size === count ? raw as Settled : undefined;
}

/** Local registration and session snapshot identity, checked again before execution. */
export function isCommandSearchCurrent(snapshot: CommandSearchSnapshot): boolean {
  if (getCommandRegistryRevision() !== snapshot.revision) return false;
  const current = getCommands();
  return current.length === snapshot.commands.length && current.every((command, index) => command === snapshot.commands[index]);
}

export async function rankCommandSnapshot(query: string, snapshot: CommandSearchSnapshot, signal: AbortSignal): Promise<CommandSearchResult> {
  if (signal.aborted) return unavailable('aborted');
  if (!isCommandSearchCurrent(snapshot)) return unavailable('stale');
  if (!query.trim() || query.length > 256 || snapshot.commands.length < 1 || snapshot.commands.length > 64) return { status: 'held', reason: 'unsupported' };
  const candidates: PaletteRequest['input']['candidates'][number][] = [];
  const seen = new Set<string>();
  for (const command of snapshot.commands) {
    const candidate = command.judgmentSource?.kind === 'chat' && command.group === 'chats' && nonempty(command.judgmentSource.sessionId)
      ? { kind: 'chat' as const, sessionId: command.judgmentSource.sessionId }
      : builtins.has(command.id) ? { kind: 'builtin' as const, commandId: command.id } : undefined;
    if (!candidate) return { status: 'held', reason: 'unsupported' };
    const identity = candidate.kind === 'chat' ? `chat:${candidate.sessionId}` : `builtin:${candidate.commandId}`;
    if (seen.has(identity)) return { status: 'held', reason: 'unsupported' };
    seen.add(identity); candidates.push(candidate);
  }
  const lifetime = getClientLifetime();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const isCurrent = () => isClientLifetimeCurrent(lifetime) && isCommandSearchCurrent(snapshot);
  try {
    if (signal.aborted) return unavailable('aborted');
    if (!isCurrent()) return unavailable('stale');
    const request: PaletteRequest = { protocolVersion: 1, requestId: randomUuid(), battery: 'webui.palette.command-rank', batteryVersion: 1,
      input: { query: { kind: 'inline', text: query }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION, candidates } };
    const raw = await runBrowserJudgment(request, abort.signal);
    if (signal.aborted) return unavailable('aborted');
    if (!isCurrent()) return unavailable('stale');
    const reading = readCommandRankResponse(request, raw);
    if (!reading) return unavailable('invalid-response');
    if (reading.status === 'held') return { status: 'held', reason: 'uncertain', reading };
    // Bind even direct consumers' returned callbacks to the originating identity.
    // Closing the palette can cancel its request; identity and registry validity
    // still decide whether the selected, already-settled command may execute.
    return { status: 'ready', reading, isCurrent, commands: reading.value.accepted.map(({ candidateIndex }) => {
      const command = snapshot.commands[candidateIndex]!;
      return Object.freeze({ ...command, run: () => { if (isCurrent()) command.run(); } });
    }) };
  } catch (error) {
    if (signal.aborted) return unavailable('aborted');
    if (!isCurrent()) return unavailable('stale');
    const code = object(object(object(error)?.body)?.error)?.code;
    if (typeof code === 'string' && ['JUDGMENT_PERMISSION_HELD', 'JUDGMENT_AUTH_REQUIRED', 'JUDGMENT_ACCESS_DENIED', 'JUDGMENT_ORIGIN_DENIED'].includes(code)) return { status: 'held', reason: 'permission' };
    if (code === 'JUDGMENT_REFERENCE_HELD') return { status: 'held', reason: 'source' };
    if (typeof code === 'string' && ['JUDGMENT_INPUT_HELD', 'JUDGMENT_INVALID_INPUT', 'JUDGMENT_INPUT_TOO_LARGE'].includes(code)) return { status: 'held', reason: 'unsupported' };
    return unavailable('unavailable');
  } finally {
    unsubscribe(); signal.removeEventListener('abort', cancel);
  }
}
