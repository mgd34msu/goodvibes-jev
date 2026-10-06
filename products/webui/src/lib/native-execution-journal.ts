import {
  nativeWorkExecutionIdentitySchema,
  type NativeWorkExecutionIdentity,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import type { NativeIntakeBrowserBinding } from "./native-intake-journal";

/** Identity only, never a bearer, grant, receipt, or authorization to execute. */
export interface NativeExecutionBrowserRecord {
  binding: NativeIntakeBrowserBinding;
  inputId: string;
  requestId: string;
  target: NativeWorkExecutionIdentity;
}

export interface NativeExecutionBrowserJournal {
  get(
    binding: NativeIntakeBrowserBinding,
    inputId: string
  ): Promise<NativeExecutionBrowserRecord | null>;
  save(record: NativeExecutionBrowserRecord): Promise<void>;
  /** Confirm the exact retained target before a mutation. This never removes it. */
  confirm(record: NativeExecutionBrowserRecord): Promise<void>;
}

export const NATIVE_EXECUTION_BROWSER_JOURNAL_DATABASE = "goodvibes.native-execution.v1";
export const NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS = 128;
export const NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_BYTES = 1024 * 1024;
const STORE = "targets";
const BINDING_KEYS = ["endpoint", "projectId", "principalId", "transport"];
const KEY_PATH = [...BINDING_KEYS.map((key) => `binding.${key}`), "inputId"];
const REQUEST_KEY_PATH = [...BINDING_KEYS.map((key) => `binding.${key}`), "requestId"];

export class NativeExecutionBrowserJournalError extends Error {
  constructor(
    readonly code:
      | "invalid-record"
      | "unavailable"
      | "durability"
      | "corrupt"
      | "conflict"
      | "missing"
      | "capacity"
  ) {
    super(
      `Native execution target journal: ${code}. The exact target must be durably retained before execution changes.`
    );
    this.name = "NativeExecutionBrowserJournalError";
  }
}

/** Refuse hidden fields and accessors as well as ordinary unknown JSON keys. */
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        keys.includes(key) &&
        descriptor !== undefined &&
        "value" in descriptor
      );
    })
  );
}

function bindingSnapshot(value: unknown): NativeIntakeBrowserBinding {
  if (!exactObject(value, BINDING_KEYS))
    throw new NativeExecutionBrowserJournalError("invalid-record");
  const { endpoint, projectId, principalId, transport } = value;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 2048 ||
    endpoint.trim() !== endpoint ||
    typeof projectId !== "string" ||
    !projectId.trim() ||
    projectId.length > 200 ||
    typeof principalId !== "string" ||
    !principalId.trim() ||
    principalId.length > 200 ||
    typeof transport !== "string" ||
    !/^(?:direct|relay:[A-Za-z0-9_-]{1,200})$/.test(transport)
  ) {
    throw new NativeExecutionBrowserJournalError("invalid-record");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NativeExecutionBrowserJournalError("invalid-record");
  }
  // Endpoint authentication must remain in the live transport, never this journal.
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NativeExecutionBrowserJournalError("invalid-record");
  }
  return { endpoint, projectId, principalId, transport };
}

function identifierSnapshot(value: unknown): string {
  // Match the intake wire input/request identities without trimming or rewriting them.
  if (typeof value !== "string" || value.length < 1 || value.length > 200)
    throw new NativeExecutionBrowserJournalError("invalid-record");
  return value;
}

function recordSnapshot(value: unknown): NativeExecutionBrowserRecord {
  if (
    !exactObject(value, ["binding", "inputId", "requestId", "target"]) ||
    !exactObject(value.target, ["workId", "attemptId", "expectedRevision"]) ||
    !exactObject(value.target.expectedRevision, ["work", "criteria", "attempt"])
  ) {
    throw new NativeExecutionBrowserJournalError("invalid-record");
  }
  const parsed = nativeWorkExecutionIdentitySchema.safeParse(value.target);
  if (!parsed.success) throw new NativeExecutionBrowserJournalError("invalid-record");
  return {
    binding: bindingSnapshot(value.binding),
    inputId: identifierSnapshot(value.inputId),
    requestId: identifierSnapshot(value.requestId),
    target: parsed.data,
  };
}

function sameBinding(left: NativeIntakeBrowserBinding, right: NativeIntakeBrowserBinding): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.projectId === right.projectId &&
    left.principalId === right.principalId &&
    left.transport === right.transport
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function readRecords(values: unknown[]): NativeExecutionBrowserRecord[] {
  if (values.length > NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS)
    throw new NativeExecutionBrowserJournalError("capacity");
  let records: NativeExecutionBrowserRecord[];
  try {
    records = values.map(recordSnapshot);
  } catch {
    throw new NativeExecutionBrowserJournalError("corrupt");
  }
  if (
    records.reduce((total, record) => total + encodedBytes(record), 0) >
    NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_BYTES
  ) {
    throw new NativeExecutionBrowserJournalError("capacity");
  }
  const inputs = new Set<string>();
  const requests = new Set<string>();
  for (const record of records) {
    const owner = BINDING_KEYS.map(
      (key) => record.binding[key as keyof NativeIntakeBrowserBinding]
    );
    const input = JSON.stringify([...owner, record.inputId]);
    const request = JSON.stringify([...owner, record.requestId]);
    if (inputs.has(input) || requests.has(request))
      throw new NativeExecutionBrowserJournalError("corrupt");
    inputs.add(input);
    requests.add(request);
  }
  return records;
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      settled = true;
      reject(new NativeExecutionBrowserJournalError("unavailable"));
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, 1);
    } catch {
      fail();
      return;
    }
    request.onerror = fail;
    request.onblocked = fail;
    request.onupgradeneeded = () => {
      try {
        // This separate database never migrates or rewrites the original source journal.
        const store = request.result.createObjectStore(STORE, { keyPath: KEY_PATH });
        store.createIndex("request", REQUEST_KEY_PATH, { unique: true });
      } catch {
        request.transaction?.abort();
        fail();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
      };
      settled = true;
      resolve(database);
    };
  });
}

/**
 * No localStorage fallback: read/validate/add share one cross-tab serialized transaction.
 * Only strict transaction completion acknowledges durability, never request.onsuccess.
 * Retained identities remain inspectable after the source scope goes stale. They
 * do not grant authority: the daemon independently validates every operation.
 * Browsers may still lose user-cleared site data; no browser API can prevent that.
 */
export function createNativeExecutionBrowserJournal(
  options: {
    indexedDB?: IDBFactory;
    databaseName?: string;
  } = {}
): NativeExecutionBrowserJournal {
  async function transaction<T>(
    operate: (records: NativeExecutionBrowserRecord[], store: IDBObjectStore) => T
  ): Promise<T> {
    let factory: IDBFactory | undefined;
    try {
      factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    } catch {
      throw new NativeExecutionBrowserJournalError("unavailable");
    }
    if (!factory) throw new NativeExecutionBrowserJournalError("unavailable");
    const database = await openDatabase(
      factory,
      options.databaseName ?? NATIVE_EXECUTION_BROWSER_JOURNAL_DATABASE
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = database.transaction(STORE, "readwrite", { durability: "strict" });
        } catch {
          reject(new NativeExecutionBrowserJournalError("durability"));
          return;
        }
        let result: T;
        let ready = false;
        let failure: Error | undefined;
        const fail = (error: unknown) => {
          failure =
            error instanceof Error ? error : new NativeExecutionBrowserJournalError("durability");
          try {
            tx.abort();
          } catch {
            reject(failure);
          }
        };
        tx.onabort = () => {
          reject(failure ?? new NativeExecutionBrowserJournalError("durability"));
        };
        tx.onerror = () => {
          failure ??= new NativeExecutionBrowserJournalError("durability");
        };
        tx.oncomplete = () => {
          if (failure || !ready)
            reject(failure ?? new NativeExecutionBrowserJournalError("durability"));
          else resolve(result);
        };
        if (tx.durability !== "strict") {
          fail(new NativeExecutionBrowserJournalError("durability"));
          return;
        }
        try {
          const store = tx.objectStore(STORE);
          const requestIndex = store.index("request");
          if (
            JSON.stringify(store.keyPath) !== JSON.stringify(KEY_PATH) ||
            JSON.stringify(requestIndex.keyPath) !== JSON.stringify(REQUEST_KEY_PATH) ||
            !requestIndex.unique
          ) {
            fail(new NativeExecutionBrowserJournalError("corrupt"));
            return;
          }
          const read: IDBRequest<unknown[]> = store.getAll(
            undefined,
            NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS + 1
          );
          read.onsuccess = () => {
            try {
              result = operate(readRecords(read.result), store);
              ready = true;
            } catch (error) {
              fail(error);
            }
          };
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      database.close();
    }
  }

  return {
    async get(binding, inputId) {
      const snapshot = bindingSnapshot(binding);
      const selectedInput = identifierSnapshot(inputId);
      return transaction(
        (records) =>
          records.find(
            (record) => sameBinding(record.binding, snapshot) && record.inputId === selectedInput
          ) ?? null
      );
    },
    async save(record) {
      // Snapshot synchronously, before opening IndexedDB or yielding to caller mutation.
      const snapshot = recordSnapshot(record);
      await transaction((records, store) => {
        const existing = records.find(
          (item) =>
            sameBinding(item.binding, snapshot.binding) &&
            (item.inputId === snapshot.inputId || item.requestId === snapshot.requestId)
        );
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(snapshot))
            throw new NativeExecutionBrowserJournalError("conflict");
          return;
        }
        const bytes = records.reduce(
          (total, item) => total + encodedBytes(item),
          encodedBytes(snapshot)
        );
        if (
          records.length >= NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS ||
          bytes > NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_BYTES
        ) {
          throw new NativeExecutionBrowserJournalError("capacity");
        }
        // add (never put) also enforces immutable input identity at the database boundary.
        store.add(snapshot);
      });
    },
    async confirm(record) {
      const snapshot = recordSnapshot(record);
      await transaction((records) => {
        const existing = records.find(
          (item) => sameBinding(item.binding, snapshot.binding) && item.inputId === snapshot.inputId
        );
        if (!existing) throw new NativeExecutionBrowserJournalError("missing");
        if (JSON.stringify(existing) !== JSON.stringify(snapshot))
          throw new NativeExecutionBrowserJournalError("conflict");
      });
    },
  };
}
