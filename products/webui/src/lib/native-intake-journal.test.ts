import { describe, expect, test } from "bun:test";
import {
  createNativeIntakeBrowserJournal,
  NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES,
  NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS,
  type NativeIntakeBrowserBinding,
  type NativeIntakeBrowserRecord,
} from "./native-intake-journal";

const binding: NativeIntakeBrowserBinding = {
  endpoint: "https://daemon.example/project",
  projectId: "project-1",
  principalId: "principal-1",
  transport: "direct",
};
function record(id = "1"): NativeIntakeBrowserRecord {
  return {
    binding: { ...binding },
    command: {
      requestId: `request-${id}`,
      inputId: `input-${id}`,
      text: "  Same café e\u0301 😀 task\r\nSame café e\u0301 😀 task  ",
      unsupportedSources: [
        { kind: "image", label: "  Original image  " },
        { kind: "image", label: "  Original image  " },
      ],
    },
    createdAt: 123,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Event/fault double only. Real IndexedDB serialization is covered by browser tests. */
function databaseDouble() {
  let values: unknown[] = [];
  let exists = false;
  let tail = Promise.resolve();
  const state = {
    commits: 0,
    adds: 0,
    closes: 0,
    opens: 0,
    openError: false,
    blocked: false,
    transactionError: false,
    readError: false,
    addError: false,
    commitError: false,
    badSchema: false,
    durability: "strict",
    beforeCommit: undefined as (() => Promise<void>) | undefined,
    transactions: [] as {
      mode: IDBTransactionMode | undefined;
      options: IDBTransactionOptions | undefined;
    }[],
    values: () => structuredClone(values),
    seed: (seed: unknown[]) => {
      values = structuredClone(seed);
    },
  };
  const keyPath = [
    "binding.endpoint",
    "binding.projectId",
    "binding.principalId",
    "binding.transport",
    "command.inputId",
  ];
  const requestKeyPath = [...keyPath.slice(0, -1), "command.requestId"];
  const database = {
    onversionchange: null as (() => void) | null,
    close() {
      state.closes++;
    },
    createObjectStore() {
      return { createIndex() {} };
    },
    transaction(_store: string, mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      state.transactions.push({ mode, options });
      if (state.transactionError) throw new Error("Cannot create transaction");
      let aborted = false;
      let read: { result: unknown[]; onsuccess: (() => void) | null } | undefined;
      const pending: unknown[] = [];
      const tx = {
        durability: state.durability,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        abort() {
          aborted = true;
        },
        objectStore() {
          return {
            keyPath: state.badSchema ? "bad" : keyPath,
            index() {
              return { keyPath: requestKeyPath, unique: true };
            },
            getAll(_query: unknown, count: number) {
              read = { result: [], onsuccess: null };
              // Materialize under the serialized transaction, not when it was queued.
              Object.defineProperty(read, "result", {
                get: () => structuredClone(values.slice(0, count)),
              });
              return read;
            },
            add(value: unknown) {
              state.adds++;
              if (state.addError) throw new Error("Quota failure");
              pending.push(structuredClone(value));
              return {};
            },
          };
        },
      };
      tail = tail.then(async () => {
        if (!aborted && state.readError) {
          tx.onerror?.();
          aborted = true;
        }
        if (!aborted) read?.onsuccess?.();
        if (!aborted) await state.beforeCommit?.();
        if (state.commitError) {
          tx.onerror?.();
          aborted = true;
        }
        if (aborted) tx.onabort?.();
        else {
          values.push(...pending);
          state.commits++;
          tx.oncomplete?.();
        }
      });
      return tx;
    },
  };
  const factory = {
    open() {
      state.opens++;
      const request = {
        result: database,
        transaction: { abort() {} },
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (state.openError) {
          request.onerror?.();
          return;
        }
        if (state.blocked) {
          request.onblocked?.();
          return;
        }
        if (!exists) {
          request.onupgradeneeded?.();
          exists = true;
        }
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return {
    state,
    journal: () => createNativeIntakeBrowserJournal({ indexedDB: factory }),
  };
}

describe("native intake immutable browser source journal", () => {
  test("preserves exact whitespace, Unicode, repetitions and ordered source markers across owners", async () => {
    const storage = databaseDouble();
    const original = record();
    await storage.journal().save(original);
    expect(await storage.journal().list(binding)).toEqual([original]);
    await storage.journal().confirm(original);
    expect(storage.state.adds).toBe(1);
    expect(
      storage.state.transactions.every(
        (tx) => tx.mode === "readwrite" && tx.options?.durability === "strict"
      )
    ).toBe(true);
  });

  test("snapshots before caller mutation and returns independent records", async () => {
    const storage = databaseDouble();
    const original = record();
    const expected = structuredClone(original);
    const saving = storage.journal().save(original);
    original.command.text = "Rewritten after capture";
    original.command.unsupportedSources[0]!.label = "Rewritten marker";
    original.binding.projectId = "changed";
    await saving;
    const listed = await storage.journal().list(binding);
    expect(listed).toEqual([expected]);
    listed[0]!.command.text = "Rewritten after list";
    expect(await storage.journal().list(binding)).toEqual([expected]);
  });

  test("waits for strict transaction completion, not successful add/read requests", async () => {
    const storage = databaseDouble();
    const entered = deferred();
    const release = deferred();
    storage.state.beforeCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    let settled = false;
    const saving = storage
      .journal()
      .save(record())
      .then(() => {
        settled = true;
      });
    await entered.promise;
    expect(storage.state.adds).toBe(1);
    expect(settled).toBe(false);
    expect(storage.state.values()).toEqual([]);
    release.resolve();
    await saving;
    expect(settled).toBe(true);
    expect(storage.state.commits).toBe(1);
  });

  test("duplicate delivery is idempotent without replacing any original", async () => {
    const storage = databaseDouble();
    const original = record();
    await storage.journal().save(original);
    await storage.journal().save(structuredClone(original));
    await storage.journal().confirm(original);
    expect(storage.state.adds).toBe(1);
    expect(storage.state.values()).toEqual([original]);
  });

  test("new deliberate identical messages retain distinct input and request identities", async () => {
    const storage = databaseDouble();
    await Promise.all([storage.journal().save(record("a")), storage.journal().save(record("b"))]);
    expect(await storage.journal().list(binding)).toEqual([record("a"), record("b")]);
  });

  test("concurrent owners cannot overwrite one input or reuse one request", async () => {
    for (const change of [
      (other: NativeIntakeBrowserRecord) => {
        other.command.text = "Changed";
      },
      (other: NativeIntakeBrowserRecord) => {
        other.command.inputId = "another-input";
      },
      (other: NativeIntakeBrowserRecord) => {
        other.command.requestId = "another-request";
      },
      (other: NativeIntakeBrowserRecord) => {
        other.createdAt++;
      },
      (other: NativeIntakeBrowserRecord) => {
        other.command.unsupportedSources.reverse();
        other.command.unsupportedSources[0]!.label = "Changed";
      },
    ]) {
      const storage = databaseDouble();
      const changed = record();
      change(changed);
      const outcomes = await Promise.allSettled([
        storage.journal().save(record()),
        storage.journal().save(changed),
      ]);
      expect(outcomes[0]!.status).toBe("fulfilled");
      expect(outcomes[1]!.status).toBe("rejected");
      expect(storage.state.values()).toEqual([record()]);
    }
  });

  test("lists and confirms only exact host, project, principal and transport bindings", async () => {
    const storage = databaseDouble();
    await storage.journal().save(record());
    for (const different of [
      { endpoint: "https://another.example/project" },
      { projectId: "other-project" },
      { principalId: "other-principal" },
      { transport: "relay:public_key" },
    ]) {
      const other = { ...binding, ...different };
      expect(await storage.journal().list(other)).toEqual([]);
      await expect(
        storage.journal().confirm({ ...record(), binding: other })
      ).rejects.toMatchObject({ code: "missing" });
      await storage.journal().save({ ...record(), binding: other });
      expect(await storage.journal().list(other)).toEqual([{ ...record(), binding: other }]);
    }
    expect(await storage.journal().list(binding)).toEqual([record()]);
  });

  test("confirm requires exact persisted command and cannot recreate a missing original", async () => {
    const storage = databaseDouble();
    await expect(storage.journal().confirm(record())).rejects.toMatchObject({ code: "missing" });
    await storage.journal().save(record());
    for (const changed of [
      { ...record(), command: { ...record().command, text: record().command.text.trim() } },
      { ...record(), command: { ...record().command, requestId: "changed" } },
      { ...record(), command: { ...record().command, unsupportedSources: [] } },
    ])
      await expect(storage.journal().confirm(changed)).rejects.toMatchObject({ code: "conflict" });
    expect(storage.state.values()).toEqual([record()]);
  });

  test("rejects injected fields, credentials in binding and malformed commands before opening storage", async () => {
    const storage = databaseDouble();
    const invalid: unknown[] = [
      { ...record(), authority: "injected" },
      { ...record(), createdAt: Infinity },
      { ...record(), createdAt: -1 },
      { ...record(), createdAt: 0.5 },
      ...["token", "rid", "daemonPublicKey"].map((key) => ({
        ...record(),
        binding: { ...binding, [key]: "credential" },
      })),
      ...[
        "https://user:password@daemon.example",
        "https://daemon.example/?token=secret",
        "https://daemon.example/#token",
        "file:///tmp",
        " https://daemon.example",
        "",
      ].map((endpoint) => ({ ...record(), binding: { ...binding, endpoint } })),
      ...[
        "relay:public:key:rid",
        "relay:",
        "relay:https://relay.example?rid=secret",
        "Bearer secret",
      ].map((transport) => ({ ...record(), binding: { ...binding, transport } })),
      { ...record(), binding: { ...binding, principalId: "" } },
      ...["actorId", "projectId", "proof", "source", "criteria", "decision"].map((key) => ({
        ...record(),
        command: { ...record().command, [key]: "injected" },
      })),
      ...["", " \r\n ", "x".repeat(20_001)].map((text) => ({
        ...record(),
        command: { ...record().command, text },
      })),
      { ...record(), command: { ...record().command, inputId: "" } },
      { ...record(), command: { ...record().command, requestId: "x".repeat(201) } },
      ...[
        undefined,
        null,
        [{ kind: "image", label: "source", url: "injected" }],
        [{ kind: "unknown", label: "source" }],
        [{ kind: "file", label: "" }],
        [{ kind: "file", label: "x".repeat(201) }],
        Array(101).fill({ kind: "context", label: "source" }),
      ].map((unsupportedSources) => ({
        ...record(),
        command: { ...record().command, unsupportedSources },
      })),
    ];
    for (const input of invalid)
      await expect(
        storage.journal().save(input as NativeIntakeBrowserRecord)
      ).rejects.toMatchObject({ code: "invalid-record" });
    expect(storage.state.opens).toBe(0);
  });

  test("rejects hidden properties and getters without evaluating them", async () => {
    const storage = databaseDouble();
    let accessed = false;
    const accessor = record();
    Object.defineProperty(accessor.command, "text", {
      get() {
        accessed = true;
        return "secret";
      },
    });
    await expect(storage.journal().save(accessor)).rejects.toMatchObject({
      code: "invalid-record",
    });
    expect(accessed).toBe(false);
    const hidden = record();
    Object.defineProperty(hidden.binding, "token", { value: "secret" });
    await expect(storage.journal().save(hidden)).rejects.toMatchObject({ code: "invalid-record" });
    const symbol = record();
    Object.defineProperty(symbol, Symbol("secret"), { value: "secret" });
    await expect(storage.journal().save(symbol)).rejects.toMatchObject({ code: "invalid-record" });
  });

  test("retains all unresolved originals at record capacity, including across bindings", async () => {
    const storage = databaseDouble();
    const originals = Array.from(
      { length: NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS },
      (_, index) => record(String(index))
    );
    storage.state.seed(originals);
    const extra = { ...record("extra"), binding: { ...binding, principalId: "another-principal" } };
    await expect(storage.journal().save(extra)).rejects.toMatchObject({ code: "capacity" });
    await storage.journal().save(originals[0]!);
    await storage.journal().confirm(originals[0]!);
    expect(storage.state.values()).toEqual(originals);
    expect(storage.state.adds).toBe(0);
  });

  test("enforces encoded-byte capacity without truncating or evicting any original", async () => {
    const storage = databaseDouble();
    const large = record();
    large.command.text = "\u0001".repeat(20_000);
    large.command.unsupportedSources = Array.from({ length: 100 }, () => ({
      kind: "file",
      label: "\u0001".repeat(200),
    }));
    const originals: NativeIntakeBrowserRecord[] = [];
    let bytes = 0;
    while (true) {
      const next = {
        ...large,
        command: {
          ...large.command,
          inputId: `input-${originals.length}`,
          requestId: `request-${originals.length}`,
        },
      };
      const size = new TextEncoder().encode(JSON.stringify(next)).byteLength;
      if (bytes + size > NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES) {
        storage.state.seed(originals);
        await expect(storage.journal().save(next)).rejects.toMatchObject({ code: "capacity" });
        break;
      }
      originals.push(next);
      bytes += size;
    }
    expect(originals.length).toBeLessThan(NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS);
    expect(storage.state.values()).toEqual(originals);
  });

  test("never treats corrupt or over-limit persisted data as an empty journal", async () => {
    for (const existing of [
      [{ ...record(), command: { ...record().command, text: "" } }],
      [{ ...record(), token: "unexpected" }],
      Array.from({ length: NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS + 1 }, (_, index) =>
        record(String(index))
      ),
    ]) {
      const storage = databaseDouble();
      storage.state.seed(existing);
      await expect(storage.journal().list(binding)).rejects.toBeInstanceOf(Error);
      await expect(storage.journal().save(record("new"))).rejects.toBeInstanceOf(Error);
      expect(storage.state.values()).toEqual(existing);
    }
  });

  test("fails closed when IndexedDB opening, read, commit or strict durability is unavailable", async () => {
    for (const failure of [
      "openError",
      "blocked",
      "transactionError",
      "readError",
      "commitError",
      "badSchema",
    ] as const) {
      const storage = databaseDouble();
      storage.state[failure] = true;
      await expect(storage.journal().save(record())).rejects.toBeInstanceOf(Error);
      expect(storage.state.values()).toEqual([]);
    }
    for (const durability of ["default", "relaxed", ""]) {
      const storage = databaseDouble();
      storage.state.durability = durability;
      await expect(storage.journal().save(record())).rejects.toMatchObject({ code: "durability" });
      expect(storage.state.adds).toBe(0);
    }
  });

  test("keeps previous originals when quota or transaction completion fails", async () => {
    for (const failure of ["addError", "commitError"] as const) {
      const storage = databaseDouble();
      await storage.journal().save(record());
      storage.state[failure] = true;
      await expect(storage.journal().save(record("new"))).rejects.toBeInstanceOf(Error);
      expect(storage.state.values()).toEqual([record()]);
      storage.state[failure] = false;
      await storage.journal().confirm(record());
    }
  });
});

test("continuation identity survives strict source-journal reload without saving transcript or authority", async () => {
  const storage = databaseDouble();
  const original = record();
  original.command.continuation = { sessionId: "native-session" };
  await storage.journal().save(original);
  expect(await storage.journal().list(binding)).toEqual([original]);
  await storage.journal().confirm(original);
  const changed = structuredClone(original);
  changed.command.continuation!.sessionId = "another-session";
  await expect(storage.journal().confirm(changed)).rejects.toMatchObject({ code: "conflict" });
  await expect(storage.journal().save(changed)).rejects.toMatchObject({ code: "conflict" });
});

for (const continuation of [
  undefined,
  null,
  {},
  { sessionId: "" },
  { sessionId: "s", transcript: [] },
  { sessionId: "s", revision: "invented" },
  { sessionId: "s", permit: {} },
])
  test("source journal rejects malformed or authority-bearing continuation records", async () => {
    const storage = databaseDouble();
    const original = record();
    Object.assign(original.command, { continuation });
    await expect(storage.journal().save(original)).rejects.toMatchObject({
      code: "invalid-record",
    });
    expect(storage.state.opens).toBe(0);
    storage.state.seed([original]);
    await expect(storage.journal().list(binding)).rejects.toMatchObject({ code: "corrupt" });
  });

test("source journal rejects continuation accessors and hidden fields without evaluating them", async () => {
  const storage = databaseDouble();
  const original = record();
  let read = false;
  const continuation = Object.defineProperty({}, "sessionId", {
    enumerable: true,
    get() {
      read = true;
      return "native";
    },
  });
  Object.assign(original.command, { continuation });
  await expect(storage.journal().save(original)).rejects.toMatchObject({ code: "invalid-record" });
  expect(read).toBe(false);
  Object.assign(original.command, {
    continuation: Object.defineProperty({ sessionId: "native" }, "secret", {
      value: "hidden",
      enumerable: false,
    }),
  });
  await expect(storage.journal().save(original)).rejects.toMatchObject({ code: "invalid-record" });
  expect(storage.state.opens).toBe(0);
});

test("selected diff identity is immutable alongside the exact comment without browser-authored context", async () => {
  const storage = databaseDouble();
  const source = record("diff");
  source.command.continuation = { sessionId: "native-session", selectedDiff: { kind: "workspace", baselineId: "base", revision: "a".repeat(64), fileIndex: 1, hunkIndex: 2 } };
  const expected = structuredClone(source);
  const saving = storage.journal().save(source);
  source.command.continuation.selectedDiff!.hunkIndex = 9;
  await saving;
  expect(await storage.journal().list(binding)).toEqual([expected]);
  await expect(storage.journal().confirm(source)).rejects.toThrow("conflict");
  const forged = structuredClone(expected);
  Object.assign(forged.command.continuation!.selectedDiff!, { unifiedDiff: "manufactured" });
  await expect(storage.journal().save(forged)).rejects.toThrow("invalid-record");
  let invoked = false;
  const getter = record("getter");
  getter.command.continuation = { sessionId: "native-session", selectedDiff: { kind: "session", revision: "a".repeat(64), fileIndex: 0, hunkIndex: 0 } };
  Object.defineProperty(getter.command.continuation.selectedDiff!, "revision", { enumerable: true, get: () => { invoked = true; return "a".repeat(64); } });
  await expect(storage.journal().save(getter)).rejects.toThrow("invalid-record");
  expect(invoked).toBe(false);
});
