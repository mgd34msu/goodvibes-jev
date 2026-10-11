import { sseSubscribers } from '../metrics.js';
import type {
  TelemetryCapabilities,
  TelemetryFilter,
  TelemetryListResponse,
  TelemetryRecord,
  TelemetryViewMode,
} from './api.js';
import {
  clampLimit,
  sanitizeRecord,
} from './api-helpers.js';
import {
  resolveTelemetryRecordCursor,
  telemetryRecordMatches,
} from './api-query.js';

export interface CreateTelemetryStreamInput {
  readonly request: Request;
  readonly filter: TelemetryFilter;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly assertViewAvailable: () => void;
  readonly records: readonly TelemetryRecord[];
  readonly listEventPage: (
    filter: TelemetryFilter,
    view: TelemetryViewMode,
    rawAccessible: boolean,
  ) => TelemetryListResponse<TelemetryRecord>;
  readonly subscribe: (listener: (record: TelemetryRecord) => void) => () => void;
  readonly getCapabilities: () => TelemetryCapabilities;
  readonly getSubscriberCount: () => number;
}

export function createTelemetryEventStream(input: CreateTelemetryStreamInput): Response {
  input.assertViewAvailable();
  const encoder = new TextEncoder();
  let unsub = (): void => {};
  const requestedCursor = input.request.headers.get('last-event-id')?.trim() || input.filter.cursor;
  if (requestedCursor) {
    resolveTelemetryRecordCursor(input.records, requestedCursor);
  }

  let teardown = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      let closed = false;
      const stop = (error?: unknown): void => {
        if (closed) return;
        closed = true;
        teardown();
        if (error !== undefined) controller.error(error);
        else controller.close();
      };
      const checkAccess = (): boolean => {
        try {
          input.assertViewAvailable();
          return true;
        } catch (error) {
          stop(error);
          return false;
        }
      };
      if (requestedCursor) {
        const replay = input.listEventPage({
          ...input.filter,
          cursor: requestedCursor,
          limit: clampLimit(input.filter.limit, 100),
        }, input.view, input.rawAccessible);
        for (const record of [...replay.items].reverse()) {
          if (!checkAccess()) return;
          controller.enqueue(encoder.encode(`id: ${record.id}\nevent: telemetry\ndata: ${JSON.stringify(record)}\n\n`));
        }
      }
      unsub = input.subscribe((record) => {
        if (closed || !checkAccess()) return;
        if (!telemetryRecordMatches(record, input.filter)) return;
        const projected = sanitizeRecord(record, input.view);
        controller.enqueue(encoder.encode(`id: ${projected.id}\nevent: telemetry\ndata: ${JSON.stringify(projected)}\n\n`));
      });
      sseSubscribers.set(input.getSubscriberCount(), { stream_type: 'telemetry' });
      const heartbeat = setInterval(() => {
        if (closed || !checkAccess()) return;
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      teardown = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsub();
        input.request.signal.removeEventListener('abort', abort);
        sseSubscribers.set(input.getSubscriberCount(), { stream_type: 'telemetry' });
      };
      const abort = (): void => stop();
      input.request.signal.addEventListener('abort', abort, { once: true });
      controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({
        version: 1,
        capabilities: input.getCapabilities(),
        view: input.view,
        rawAccessible: input.rawAccessible,
        ...(requestedCursor ? { resumedFrom: requestedCursor } : {}),
      })}\n\n`));
    },
    cancel: () => {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
