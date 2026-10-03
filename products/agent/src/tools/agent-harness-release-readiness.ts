import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE_READINESS_RELATIVE_PATH = 'release/release-readiness.json';
const RELEASE_READINESS_PATH = join(import.meta.dir, '..', '..', RELEASE_READINESS_RELATIVE_PATH);
const QUALITY_DIMENSIONS = [
  'capabilityCoverage',
  'userAccess',
  'modelAccess',
  'safetyBoundary',
  'releaseEvidence',
] as const;

interface ReleaseReadinessArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly itemId?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

interface ReleaseReadinessLookup {
  readonly source: 'itemId' | 'target' | 'query';
  readonly input: string;
}

type ReleaseReadinessLoadResult =
  | { readonly status: 'available'; readonly root: Record<string, unknown>; readonly source: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export type ReleaseReadinessItemResolution =
  | {
    readonly status: 'found';
    readonly path: string;
    readonly lookup: ReleaseReadinessLookup & { readonly resolvedBy: 'id' | 'case-insensitive-id' | 'capability' | 'search' };
    readonly item: Record<string, unknown>;
  }
  | {
    readonly status: 'ambiguous';
    readonly path: string;
    readonly input: string;
    readonly candidates: readonly Record<string, unknown>[];
  }
  | {
    readonly status: 'not_found' | 'missing_lookup' | 'unavailable';
    readonly path: string;
    readonly input?: string;
    readonly reason?: string;
    readonly total?: number;
    readonly usage?: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function loadReleaseReadiness(): ReleaseReadinessLoadResult {
  if (!existsSync(RELEASE_READINESS_PATH)) {
    return { status: 'unavailable', reason: `${RELEASE_READINESS_RELATIVE_PATH} is not present in this Agent installation.` };
  }
  try {
    const source = readFileSync(RELEASE_READINESS_PATH, 'utf-8');
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) return { status: 'unavailable', reason: `${RELEASE_READINESS_RELATIVE_PATH} must contain a JSON object.` };
    return { status: 'available', root: parsed, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unavailable', reason: `${RELEASE_READINESS_RELATIVE_PATH} could not be read: ${message}` };
  }
}

function releaseReadinessItems(root: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(root.items) ? root.items.filter(isRecord) : [];
}

function releaseReadinessSources(root: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(root.sources) ? root.sources.filter(isRecord) : [];
}

function normalized(value: string): string {
  return value.toLowerCase();
}

function itemSearchText(item: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const key of ['id', 'capability', 'owner', 'status', 'evidence', 'action'] as const) {
    const value = item[key];
    if (typeof value === 'string') fields.push(value);
  }
  if (isRecord(item.quality)) {
    fields.push(...Object.values(item.quality).filter((value): value is string => typeof value === 'string'));
  }
  return fields.join('\n').toLowerCase();
}

function releaseReadinessModelRoute(item?: Record<string, unknown>): string {
  if (item) return 'audit action:"item"';
  return 'audit action:"readiness" or action:"item"';
}

function releaseReadinessPolicy(): Record<string, unknown> {
  return {
    effect: 'operator-audit-read-only',
    audience: 'release operators and maintainers',
    values: 'Returns release-quality inventory status, evidence, and quality dimensions for audit.',
    boundary: 'Release readiness is audit material. It is not a visible product route and does not mutate runtime state.',
  };
}

function countBy(items: readonly Record<string, unknown>[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = readString(item[key]) || '<missing>';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function qualityDimensionCount(item: Record<string, unknown>): number {
  const quality = item.quality;
  if (!isRecord(quality)) return 0;
  return QUALITY_DIMENSIONS.filter((dimension) => readString(quality[dimension])).length;
}

function summarizeSource(source: Record<string, unknown>): Record<string, unknown> {
  return {
    id: source.id,
    kind: source.kind,
    observedAt: source.observedAt,
  };
}

function summarizeItem(item: Record<string, unknown>, options: { readonly includeQuality?: boolean } = {}): Record<string, unknown> {
  return {
    id: item.id,
    capability: item.capability,
    owner: item.owner,
    status: item.status,
    evidence: item.evidence,
    action: item.action,
    modelRoute: releaseReadinessModelRoute(item),
    ...(options.includeQuality ? { quality: item.quality } : {}),
    ...(options.includeQuality ? {
      policy: releaseReadinessPolicy(),
      modelAccess: {
        listItems: 'audit action:"readiness"',
        inspectItem: `audit action:"item" itemId:"${readString(item.id)}"`,
        lowerLevelItem: `agent_harness mode:"release_readiness_item" itemId:"${readString(item.id)}" includeParameters:true`,
      },
    } : {}),
  };
}

function readinessLookupFromArgs(args: ReleaseReadinessArgs): ReleaseReadinessLookup | null {
  const itemId = readString(args.itemId);
  if (itemId) return { source: 'itemId', input: itemId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function releaseReadinessCandidates(items: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return items.slice(0, 10).map((item) => ({
    id: item.id,
    capability: item.capability,
    owner: item.owner,
    status: item.status,
    modelRoute: releaseReadinessModelRoute(item),
  }));
}

export function releaseReadinessInventoryStatus(): Record<string, unknown> {
  const loaded = loadReleaseReadiness();
  if (loaded.status !== 'available') {
    return {
      status: loaded.status,
      path: RELEASE_READINESS_RELATIVE_PATH,
      reason: loaded.reason,
    };
  }
  const items = releaseReadinessItems(loaded.root);
  return {
    status: 'available',
    path: RELEASE_READINESS_RELATIVE_PATH,
    gate: loaded.root.gate,
    checkedAt: loaded.root.checkedAt,
    items: items.length,
    qualityDimensions: QUALITY_DIMENSIONS,
    modelRoute: releaseReadinessModelRoute(),
    policy: releaseReadinessPolicy(),
  };
}

export function releaseReadinessSummary(args: ReleaseReadinessArgs): Record<string, unknown> {
  const loaded = loadReleaseReadiness();
  if (loaded.status !== 'available') {
    return {
      mode: 'release_readiness',
      status: loaded.status,
      path: RELEASE_READINESS_RELATIVE_PATH,
      reason: loaded.reason,
    };
  }

  const items = releaseReadinessItems(loaded.root);
  const query = readString(args.query || args.target);
  const filtered = query ? items.filter((item) => itemSearchText(item).includes(normalized(query))) : items;
  const limit = readLimit(args.limit, 100);
  const includeQuality = args.includeParameters === true;
  const sources = releaseReadinessSources(loaded.root);
  const completeQualityDimensions = items.reduce((sum, item) => sum + qualityDimensionCount(item), 0);

  return {
    mode: 'release_readiness',
    status: 'available',
    path: RELEASE_READINESS_RELATIVE_PATH,
    gate: loaded.root.gate,
    schemaVersion: loaded.root.schemaVersion,
    checkedAt: loaded.root.checkedAt,
    policy: loaded.root.policy,
    operatorAuditPolicy: releaseReadinessPolicy(),
    modelAccess: {
      listItems: 'audit action:"readiness"',
      inspectItem: 'audit action:"item" with itemId, target, or query',
      lowerLevelItem: 'agent_harness mode:"release_readiness_item" itemId:"..." includeParameters:true',
    },
    totals: {
      items: items.length,
      filtered: filtered.length,
      returned: Math.min(filtered.length, limit),
      statuses: countBy(items, 'status'),
      owners: countBy(items, 'owner'),
      requiredQualityDimensions: QUALITY_DIMENSIONS,
      completeQualityDimensions,
      expectedQualityDimensions: items.length * QUALITY_DIMENSIONS.length,
    },
    sources: includeQuality ? sources : sources.map(summarizeSource),
    items: filtered.slice(0, limit).map((item) => summarizeItem(item, { includeQuality })),
    itemLookup: 'Use audit action:"item" with itemId, target, or query to inspect one readiness item; lower-level agent_harness mode:"release_readiness_item" remains available.',
  };
}

export function describeHarnessReleaseReadinessItem(args: ReleaseReadinessArgs): ReleaseReadinessItemResolution {
  const loaded = loadReleaseReadiness();
  if (loaded.status !== 'available') {
    return {
      status: 'unavailable',
      path: RELEASE_READINESS_RELATIVE_PATH,
      reason: loaded.reason,
    };
  }

  const items = releaseReadinessItems(loaded.root);
  const lookup = readinessLookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      path: RELEASE_READINESS_RELATIVE_PATH,
      total: items.length,
      usage: 'Provide itemId, target, or query for mode:"release_readiness_item".',
    };
  }

  const exactId = items.find((item) => item.id === lookup.input);
  if (exactId) {
    return {
      status: 'found',
      path: RELEASE_READINESS_RELATIVE_PATH,
      lookup: { ...lookup, resolvedBy: 'id' },
      item: summarizeItem(exactId, { includeQuality: true }),
    };
  }

  const input = normalized(lookup.input);
  const insensitiveId = items.find((item) => readString(item.id).toLowerCase() === input);
  if (insensitiveId) {
    return {
      status: 'found',
      path: RELEASE_READINESS_RELATIVE_PATH,
      lookup: { ...lookup, resolvedBy: 'case-insensitive-id' },
      item: summarizeItem(insensitiveId, { includeQuality: true }),
    };
  }

  const capability = items.find((item) => readString(item.capability).toLowerCase() === input);
  if (capability) {
    return {
      status: 'found',
      path: RELEASE_READINESS_RELATIVE_PATH,
      lookup: { ...lookup, resolvedBy: 'capability' },
      item: summarizeItem(capability, { includeQuality: true }),
    };
  }

  const searched = items.filter((item) => itemSearchText(item).includes(input));
  if (searched.length === 1) {
    return {
      status: 'found',
      path: RELEASE_READINESS_RELATIVE_PATH,
      lookup: { ...lookup, resolvedBy: 'search' },
      item: summarizeItem(searched[0]!, { includeQuality: true }),
    };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      path: RELEASE_READINESS_RELATIVE_PATH,
      input: lookup.input,
      candidates: releaseReadinessCandidates(searched),
    };
  }

  return {
    status: 'not_found',
    path: RELEASE_READINESS_RELATIVE_PATH,
    input: lookup.input,
    total: items.length,
  };
}
