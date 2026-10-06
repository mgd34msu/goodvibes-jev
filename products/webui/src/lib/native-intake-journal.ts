import {
  nativeConversationIntakeCaptureRequestSchema,
  type NativeConversationIntakeCaptureRequest,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";

/** Public authority only. Never include a bearer token or relay rendezvous credential. */
export interface NativeIntakeBrowserBinding {
  endpoint: string;
  projectId: string;
  principalId: string;
  /** `direct` or `relay:<daemon public key>`; the authenticated owner supplies this. */
  transport: string;
}

export interface NativeIntakeBrowserRecord {
  binding: NativeIntakeBrowserBinding;
  command: NativeConversationIntakeCaptureRequest;
  createdAt: number;
}

export interface NativeIntakeBrowserJournal {
  list(binding: NativeIntakeBrowserBinding): Promise<NativeIntakeBrowserRecord[]>;
  save(record: NativeIntakeBrowserRecord): Promise<void>;
  /** Confirm the exact persisted original immediately before replay. This never removes it. */
  confirm(record: NativeIntakeBrowserRecord): Promise<void>;
}

export const NATIVE_INTAKE_BROWSER_JOURNAL_DATABASE = "goodvibes.native-intake.v1";
export const NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS = 128;
export const NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const STORE = "captures";
const BINDING_KEYS = ["endpoint", "projectId", "principalId", "transport"];
const KEY_PATH = [...BINDING_KEYS.map((key) => `binding.${key}`), "command.inputId"];
const REQUEST_KEY_PATH = [...BINDING_KEYS.map((key) => `binding.${key}`), "command.requestId"];

export class NativeIntakeBrowserJournalError extends Error {
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
      `Native intake source journal: ${code}. Original source must be durably retained before sending.`
    );
    this.name = "NativeIntakeBrowserJournalError";
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
    throw new NativeIntakeBrowserJournalError("invalid-record");
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
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  // Endpoint authentication must remain in the live transport, never this journal.
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  return { endpoint, projectId, principalId, transport };
}

function recordSnapshot(value: unknown): NativeIntakeBrowserRecord {
  if (
    !exactObject(value, ["binding", "command", "createdAt"]) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !exactObject(value.command, ["requestId", "inputId", "text", "unsupportedSources"]) ||
    !Array.isArray(value.command.unsupportedSources) ||
    value.command.unsupportedSources.length > 100 ||
    !value.command.unsupportedSources.every((marker: unknown) =>
      exactObject(marker, ["kind", "label"])
    )
  ) {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(value.command);
  if (!parsed.success) throw new NativeIntakeBrowserJournalError("invalid-record");
  return {
    binding: bindingSnapshot(value.binding),
    command: parsed.data,
    createdAt: value.createdAt,
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

function readRecords(values: unknown[]): NativeIntakeBrowserRecord[] {
  if (values.length > NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS)
    throw new NativeIntakeBrowserJournalError("capacity");
  let records: NativeIntakeBrowserRecord[];
  try {
    records = values.map(recordSnapshot);
  } catch {
    throw new NativeIntakeBrowserJournalError("corrupt");
  }
  if (
    records.reduce((total, record) => total + encodedBytes(record), 0) >
    NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES
  ) {
    throw new NativeIntakeBrowserJournalError("capacity");
  }
  return records;
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      settled = true;
      reject(new NativeIntakeBrowserJournalError("unavailable"));
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
        // There is no migration that drops, replaces, or evicts captured originals.
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
 * Browsers may still lose user-cleared site data; no browser API can prevent that.
 */
export function createNativeIntakeBrowserJournal(
  options: {
    indexedDB?: IDBFactory;
    databaseName?: string;
  } = {}
): NativeIntakeBrowserJournal {
  async function transaction<T>(
    operate: (records: NativeIntakeBrowserRecord[], store: IDBObjectStore) => T
  ): Promise<T> {
    let factory: IDBFactory | undefined;
    try {
      factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    } catch {
      throw new NativeIntakeBrowserJournalError("unavailable");
    }
    if (!factory) throw new NativeIntakeBrowserJournalError("unavailable");
    const database = await openDatabase(
      factory,
      options.databaseName ?? NATIVE_INTAKE_BROWSER_JOURNAL_DATABASE
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = database.transaction(STORE, "readwrite", { durability: "strict" });
        } catch {
          reject(new NativeIntakeBrowserJournalError("durability"));
          return;
        }
        let result: T;
        let ready = false;
        let failure: Error | undefined;
        const fail = (error: unknown) => {
          failure =
            error instanceof Error ? error : new NativeIntakeBrowserJournalError("durability");
          try {
            tx.abort();
          } catch {
            reject(failure);
          }
        };
        tx.onabort = () => {
          reject(failure ?? new NativeIntakeBrowserJournalError("durability"));
        };
        tx.onerror = () => {
          failure ??= new NativeIntakeBrowserJournalError("durability");
        };
        tx.oncomplete = () => {
          if (failure || !ready)
            reject(failure ?? new NativeIntakeBrowserJournalError("durability"));
          else resolve(result);
        };
        if (tx.durability !== "strict") {
          fail(new NativeIntakeBrowserJournalError("durability"));
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
            fail(new NativeIntakeBrowserJournalError("corrupt"));
            return;
          }
          const read: IDBRequest<unknown[]> = store.getAll(
            undefined,
            NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS + 1
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
    async list(binding) {
      const snapshot = bindingSnapshot(binding);
      return transaction((records) =>
        records
          .filter((record) => sameBinding(record.binding, snapshot))
          .sort(
            (left, right) =>
              left.createdAt - right.createdAt ||
              left.command.inputId.localeCompare(right.command.inputId)
          )
      );
    },
    async save(record) {
      // Snapshot synchronously, before opening IndexedDB or yielding to caller mutation.
      const snapshot = recordSnapshot(record);
      await transaction((records, store) => {
        const existing = records.find(
          (item) =>
            sameBinding(item.binding, snapshot.binding) &&
            (item.command.inputId === snapshot.command.inputId ||
              item.command.requestId === snapshot.command.requestId)
        );
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(snapshot))
            throw new NativeIntakeBrowserJournalError("conflict");
          return;
        }
        const bytes = records.reduce(
          (total, item) => total + encodedBytes(item),
          encodedBytes(snapshot)
        );
        if (
          records.length >= NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS ||
          bytes > NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES
        ) {
          throw new NativeIntakeBrowserJournalError("capacity");
        }
        // add (never put) also enforces immutable input identity at the database boundary.
        store.add(snapshot);
      });
    },
    async confirm(record) {
      const snapshot = recordSnapshot(record);
      await transaction((records) => {
        const existing = records.find(
          (item) =>
            sameBinding(item.binding, snapshot.binding) &&
            item.command.inputId === snapshot.command.inputId
        );
        if (!existing) throw new NativeIntakeBrowserJournalError("missing");
        if (JSON.stringify(existing) !== JSON.stringify(snapshot))
          throw new NativeIntakeBrowserJournalError("conflict");
      });
    },
  };
}
