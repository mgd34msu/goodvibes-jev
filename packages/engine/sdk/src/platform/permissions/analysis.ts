/**
 * The request analysis every gate decision carries: what the call targets and
 * what it does, for the approval card, hooks and events.
 *
 * The structural parts are code: the target, its kind, the surface, the host
 * and the shell parser's command class and catastrophic findings. The risk
 * level, risk family, side effects and blast radius come from Jev's reading
 * of the call (gate/reading.ts) and are attached with withReading. Before a
 * reading exists (a known read-only tool, or a call an explicit owner rule or
 * the boundary decided first) the level is fixed by category: low for a
 * read-only tool, high for anything unread.
 *
 * The old secret-name and token-shape regexes over command text, the
 * sensitive-path regex and the if/else chains that picked a risk band from
 * the command class and host trust tier are gone; the side-effect and
 * risk-family batteries answer those questions.
 */
import { normalizeCommandWithVerdicts } from '../runtime/permissions/normalization/index.js';
import { extractHostname } from '../tools/fetch/trust-tiers.js';
import { RISK_HEADLINES } from '../runtime/permissions/risk-model.js';
import type { GateReading } from '../gate/reading.js';
import type {
  PermissionBlastRadius,
  PermissionCategory,
  PermissionRequestAnalysis,
} from './types.js';

function truncatePreview(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function cleanReasons(values: readonly string[], limit = 4): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) deduped.add(trimmed);
    if (deduped.size >= limit) break;
  }
  return Array.from(deduped);
}

const firstString = (args: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) if (typeof args[key] === 'string') return args[key] as string;
  return '';
};

/** The risk level before any reading: fixed by category. */
const unreadRisk = (category: PermissionCategory): PermissionRequestAnalysis['riskLevel'] => (category === 'read' ? 'low' : 'high');

function describeExec(args: Record<string, unknown>, category: PermissionCategory): PermissionRequestAnalysis {
  const command = firstString(args, ['command', 'cmd']);
  if (command.length === 0) {
    return {
      classification: 'write',
      riskLevel: unreadRisk(category),
      summary: 'Execute shell command',
      reasons: ['Shell execution can mutate files, spawn processes, or access the network.'],
      target: '',
      targetKind: 'command',
      surface: 'shell',
    };
  }
  const verdict = normalizeCommandWithVerdicts(command);
  return {
    classification: verdict.highestClassification,
    riskLevel: unreadRisk(category),
    summary: 'Execute shell command',
    reasons: cleanReasons([
      verdict.denialExplanation ?? '',
      ...verdict.segments.filter((segment) => !segment.allowed).map((segment) => segment.reason),
    ]),
    target: truncatePreview(command),
    targetKind: 'command',
    surface: 'shell',
  };
}

function describeFetch(args: Record<string, unknown>, category: PermissionCategory): PermissionRequestAnalysis {
  const urls = Array.isArray(args['urls']) ? args['urls'] : [];
  const first = urls.find((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
  const rawUrl = firstString(first ?? args, ['url', 'endpoint']);
  const host = rawUrl.length > 0 ? extractHostname(rawUrl) : null;
  return {
    classification: 'network',
    riskLevel: unreadRisk(category),
    summary: host ? `Fetch remote resource from ${host}` : 'Fetch remote resource',
    reasons: host ? [`Target host: ${host}`] : [],
    target: truncatePreview(rawUrl),
    targetKind: 'url',
    surface: 'network',
    host: host ?? undefined,
  };
}

function describePathTool(toolName: string, args: Record<string, unknown>, category: PermissionCategory): PermissionRequestAnalysis {
  const path = firstString(args, ['path', 'file', 'file_path']);
  return {
    classification: category === 'write' ? 'write' : 'read',
    riskLevel: unreadRisk(category),
    summary: category === 'write' ? `Modify local file or project state via ${toolName}` : `Read local project state via ${toolName}`,
    reasons: [],
    target: path,
    targetKind: 'path',
    surface: 'filesystem',
  };
}

function describeDelegate(toolName: string, args: Record<string, unknown>, category: PermissionCategory): PermissionRequestAnalysis {
  const task = firstString(args, ['task', 'name', 'prompt']);
  return {
    classification: 'escalation',
    riskLevel: unreadRisk(category),
    summary: `Delegate work through ${toolName}`,
    reasons: [],
    target: truncatePreview(task),
    targetKind: 'task',
    surface: 'orchestration',
  };
}

/** The structural analysis of a call, before any reading. */
export function analyzePermissionRequest(
  toolName: string,
  args: Record<string, unknown>,
  category: PermissionCategory,
): PermissionRequestAnalysis {
  if (toolName === 'exec') return describeExec(args, category);
  if (toolName === 'fetch') return describeFetch(args, category);
  if (category === 'write' || category === 'read') return describePathTool(toolName, args, category);
  if (category === 'delegate') return describeDelegate(toolName, args, category);
  return {
    classification: category,
    riskLevel: unreadRisk(category),
    summary: `Request permission for ${toolName}`,
    reasons: [],
    targetKind: 'generic',
    surface: 'shell',
  };
}

const FACT_WORDING = {
  mutates: 'changes state',
  outward: 'reaches outside this machine',
  secrets: 'touches secret or credential material',
  irreversible: 'is hard to undo',
  beyondProject: 'reaches beyond the project',
  weakensSecurity: 'loosens a security boundary',
  obfuscated: 'is written to hide what it does',
} as const;

function blastRadiusOf(reading: GateReading, category: PermissionCategory): PermissionBlastRadius {
  if (reading.weakensSecurity || reading.secrets) return 'platform';
  if (reading.outward || reading.beyondProject) return category === 'delegate' ? 'delegated' : 'external';
  if (category === 'delegate') return 'delegated';
  return reading.mutates ? 'project' : 'local';
}

/** The analysis with Jev's reading attached: risk level, family, side effects and blast radius. */
export function withReading(analysis: PermissionRequestAnalysis, reading: GateReading, category: PermissionCategory): PermissionRequestAnalysis {
  const facts = (Object.keys(FACT_WORDING) as (keyof typeof FACT_WORDING)[]).filter((name) => reading[name]);
  const uncertain = reading.uncertain.length > 0 ? [`Uncertain, taken as true: ${reading.uncertain.map((name) => FACT_WORDING[name]).join(', ')}.`] : [];
  return {
    ...analysis,
    riskLevel: reading.stakes,
    riskFamily: reading.family,
    reasons: cleanReasons([
      `${RISK_HEADLINES[reading.family]}: ${reading.stakes} stakes.`,
      facts.length > 0 ? `This call ${facts.map((name) => FACT_WORDING[name]).join(', ')}.` : 'This call changes nothing and stays on this machine.',
      ...uncertain,
      ...analysis.reasons,
    ], 5),
    sideEffects: facts.map((name) => FACT_WORDING[name]),
    blastRadius: blastRadiusOf(reading, category),
  };
}
