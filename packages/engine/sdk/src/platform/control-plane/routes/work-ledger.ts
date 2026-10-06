import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { WorkLedgerReadClient } from '../../workflow/work-ledger/index.js';
import { WorkLedgerAccessError, projectWorkLedgerReadEvent, projectWorkLedgerReadWork } from '../../workflow/work-ledger/types.js';
import {
  WORK_LEDGER_READ_SCOPE, WORK_LEDGER_HISTORY_PAGE_SIZE, WORK_LEDGER_READ_MAX_BYTES,
  workLedgerReadSnapshotSchema, type WorkLedgerHistoryPage,
} from '../method-catalog-work-ledger.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';


function invalid(field: string): never {
  throw new GatewayVerbError(`Invalid ${field}`, 'INVALID_ARGUMENT', 400, field);
}
function cursor(value: unknown, field: string): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(field);
  return value;
}
function params(invocation: GatewayMethodInvocation, reader: WorkLedgerReadClient, history: boolean): Record<string, unknown> {
  // Defense in depth: direct catalog invocations must not bypass owner/scope auth.
  if (!invocation.context.admin || !invocation.context.principalId
    || !invocation.context.scopes?.some(scope => scope === WORK_LEDGER_READ_SCOPE || scope === '*')) {
    throw new GatewayVerbError('Native ledger read requires owner access and read:work-ledger', 'FORBIDDEN', 403);
  }
  const input = readInvocationParams(invocation);
  const allowed = new Set(history ? ['projectId', 'afterSequence', 'throughSequence'] : ['projectId']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) invalid(key);
  if (typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200) invalid('projectId');
  if (input.projectId !== reader.projectId) {
    throw new GatewayVerbError('Selected host does not own the requested project', 'WORK_LEDGER_PROJECT_MISMATCH', 403, 'projectId');
  }
  return input;
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WORK_LEDGER_READ_MAX_BYTES) {
    throw new GatewayVerbError('Ledger response exceeds the read transport limit', 'WORK_LEDGER_READ_LIMIT', 413);
  }
  return value;
}
async function read<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof WorkLedgerAccessError) {
      const status = error.code === 'forbidden' ? 403 : error.code === 'invalid_cursor' ? 400 : 503;
      throw new GatewayVerbError('Authoritative work ledger read is unavailable', `WORK_LEDGER_${error.code.toUpperCase()}`, status);
    }
    if (error instanceof GatewayVerbError) throw error;
    throw new GatewayVerbError('Authoritative work ledger read is unavailable', 'WORK_LEDGER_UNAVAILABLE', 503);
  }
}

function provenance(invocation: GatewayMethodInvocation): 'available' | 'requires_read_knowledge' {
  return invocation.context.scopes?.some(scope => scope === '*' || scope === 'read:knowledge')
    && invocation.isAuthorized?.(['read:knowledge']) === true ? 'available' : 'requires_read_knowledge';
}

/** One trusted host reader, already scoped to the selected project. No path or actor inputs. */
export function registerWorkLedgerGatewayMethods(catalog: GatewayMethodCatalog, reader: WorkLedgerReadClient): void {
  const attach = (id: string, handler: (invocation: GatewayMethodInvocation) => Promise<unknown>) => {
    const descriptor = catalog.get(id);
    if (!descriptor) throw new Error(`Missing native ledger method descriptor: ${id}`);
    catalog.register(descriptor, handler, { replace: true });
  };
  attach('workLedger.project', async invocation => {
    if (!invocation.context.admin || !invocation.context.principalId
      || !invocation.context.scopes?.some(scope => scope === WORK_LEDGER_READ_SCOPE || scope === '*')
      || invocation.isAuthorized?.([WORK_LEDGER_READ_SCOPE]) !== true) {
      throw new GatewayVerbError('Native ledger discovery requires current owner access and read:work-ledger', 'FORBIDDEN', 403);
    }
    const input = readInvocationParams(invocation);
    for (const key of Object.keys(input)) invalid(key);
    // This identity is from the native ledger owner already composed by this
    // host, never from the legacy project-planning service or request payload.
    return { projectId: reader.projectId };
  });
  attach('workLedger.snapshot', async invocation => {
    params(invocation, reader, false);
    return read(async () => {
      const snapshot = workLedgerReadSnapshotSchema.parse(await reader.readSnapshot());
      if (snapshot.projectId !== reader.projectId) throw new Error('Host reader project mismatch');
      if (invocation.isAuthorized?.() === false) throw new GatewayVerbError('Owner authorization changed', 'FORBIDDEN', 403);
      return bounded({ ...snapshot, works: snapshot.works.map(view => ({ ...view, work: projectWorkLedgerReadWork(view.work) })), provenance: provenance(invocation) });
    });
  });
  attach('workLedger.history', async invocation => {
    const input = params(invocation, reader, true);
    const afterSequence = cursor(input.afterSequence, 'afterSequence');
    const through = input.throughSequence === undefined ? undefined : cursor(input.throughSequence, 'throughSequence');
    if (through !== undefined && through < afterSequence) invalid('throughSequence');
    return read(async () => {
      // Snapshot supplies an honest durable high-water mark even for an empty page.
      const snapshot = await reader.readSnapshot();
      if (snapshot.projectId !== reader.projectId) throw new Error('Host reader project mismatch');
      if (afterSequence > snapshot.cursor) invalid('afterSequence');
      if (through !== undefined && through > snapshot.cursor) invalid('throughSequence');
      const throughSequence = through ?? snapshot.cursor;
      const all = await reader.history(afterSequence);
      const page: WorkLedgerHistoryPage = {
        projectId: reader.projectId, afterSequence, cursor: afterSequence, throughSequence,
        hasMore: afterSequence < throughSequence, provenance: provenance(invocation), events: [],
      };
      for (const rawEvent of all) {
        const event = projectWorkLedgerReadEvent(rawEvent, page.provenance === 'available');
        if (event.sequence > throughSequence) break;
        if (invocation.isAuthorized?.() === false) throw new GatewayVerbError('Owner authorization changed', 'FORBIDDEN', 403);
        if (event.sequence !== page.cursor + 1) throw new Error('History cursor is not contiguous');
        const next = { ...page, cursor: event.sequence, hasMore: event.sequence < throughSequence, events: [...page.events, event] };
        if (new TextEncoder().encode(JSON.stringify(next)).byteLength > WORK_LEDGER_READ_MAX_BYTES) {
          if (page.events.length === 0) bounded(next);
          break;
        }
        page.events.push(event); page.cursor = event.sequence; page.hasMore = event.sequence < throughSequence;
        if (page.events.length === WORK_LEDGER_HISTORY_PAGE_SIZE) break;
      }
      if (page.hasMore && page.events.length === 0) throw new Error('History cursor did not advance');
      return bounded(page);
    });
  });
}
