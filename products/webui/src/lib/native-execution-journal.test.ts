import { describe, expect, test } from "bun:test";
import {
  createNativeExecutionBrowserJournal,
  NATIVE_EXECUTION_BROWSER_JOURNAL_DATABASE,
  NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_BYTES,
  NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS,
  type NativeExecutionBrowserRecord,
} from "./native-execution-journal";
import type { NativeIntakeBrowserBinding } from "./native-intake-journal";

const binding: NativeIntakeBrowserBinding = {
  endpoint: "https://daemon.example/project",
  projectId: "project-1",
  principalId: "principal-1",
  transport: "direct",
};
function record(id = "1"): NativeExecutionBrowserRecord {
  return {
    binding: { ...binding },
    inputId: `input-${id}`,
    requestId: `request-${id}`,
    target: {
      workId: `work-${id}`,
      attemptId: `attempt-${id}`,
      expectedRevision: { work: 3, criteria: 2, attempt: 1 },
    },
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
    badRequestSchema: false,
    nonUniqueRequest: false,
    indexError: false,
    upgradeError: false,
    openThrow: false,
    addRequestError: false,
    opened: [] as { name: string; version: number | undefined }[],
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
    "inputId",
  ];
  const requestKeyPath = [...keyPath.slice(0, -1), "requestId"];
  const database = {
    onversionchange: null as (() => void) | null,
    close() {
      state.closes++;
    },
    createObjectStore() {
      if (state.upgradeError) throw new Error("Cannot create object store");
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
              if (state.indexError) throw new Error("Missing request index");
              return {
                keyPath: state.badRequestSchema ? "bad" : requestKeyPath,
                unique: !state.nonUniqueRequest,
              };
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
        if (state.commitError || (pending.length > 0 && state.addRequestError)) {
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
    open(name: string, version?: number) {
      state.opens++;
      state.opened.push({ name, version });
      if (state.openThrow) throw new Error("Cannot open storage");
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
    journal: (databaseName?: string) =>
      createNativeExecutionBrowserJournal({ indexedDB: factory, databaseName }),
  };
}

describe("native execution immutable browser target journal", () => {
  test("persists exact source and target identities across owners in a separate database", async () => {
    const storage = databaseDouble();
    const original = record();
    original.inputId = "  input café e\u0301 😀  ";
    original.requestId = "  request café e\u0301 😀  ";
    original.target.workId = "  work café e\u0301 😀  ";
    original.target.attemptId = "  attempt café e\u0301 😀  ";
    original.target.expectedRevision.work = Number.MAX_SAFE_INTEGER;
    await storage.journal().save(original);
    expect(await storage.journal().get(binding, original.inputId)).toEqual(original);
    await storage.journal().confirm(original);
    expect(storage.state.adds).toBe(1);
    expect(
      storage.state.opened.every(
        ({ name, version }) => name === NATIVE_EXECUTION_BROWSER_JOURNAL_DATABASE && version === 1
      )
    ).toBe(true);
    expect(
      storage.state.transactions.every(
        (tx) => tx.mode === "readwrite" && tx.options?.durability === "strict"
      )
    ).toBe(true);
    expect(storage.state.closes).toBe(storage.state.opens);
    await storage.journal("isolated-targets").get(binding, original.inputId);
    expect(storage.state.opened.at(-1)?.name).toBe("isolated-targets");
  });

  test("snapshots before yielding and returns detached target, revision and binding objects", async () => {
    const storage = databaseDouble();
    const original = record();
    const expected = structuredClone(original);
    const saving = storage.journal().save(original);
    original.target.workId = "rewritten-work";
    original.target.expectedRevision.work++;
    original.inputId = "rewritten-input";
    original.requestId = "rewritten-request";
    original.binding.projectId = "rewritten-project";
    await saving;
    const selectedBinding = { ...binding };
    const reading = storage.journal().get(selectedBinding, expected.inputId);
    selectedBinding.principalId = "rewritten-principal";
    const found = await reading;
    expect(found).toEqual(expected);
    found!.target.expectedRevision.attempt++;
    found!.target.attemptId = "rewritten-attempt";
    found!.binding.endpoint = "https://another.example";
    expect(await storage.journal().get(binding, expected.inputId)).toEqual(expected);
    const confirming = storage.journal().confirm(expected);
    expected.target.expectedRevision.work++;
    await confirming;
    expect(storage.state.values()).toEqual([record()]);
  });

  test("waits for strict transaction completion for save, get and confirm", async () => {
    const storage = databaseDouble();
    for (const action of ["save", "get", "confirm"] as const) {
      const entered = deferred();
      const release = deferred();
      storage.state.beforeCommit = async () => {
        entered.resolve();
        await release.promise;
      };
      let settled = false;
      const journal = storage.journal();
      const operation =
        action === "get" ? journal.get(binding, record().inputId) : journal[action](record());
      const completed = operation.then(() => {
        settled = true;
      });
      await entered.promise;
      expect(settled).toBe(false);
      if (action === "save") {
        expect(storage.state.adds).toBe(1);
        expect(storage.state.values()).toEqual([]);
      }
      release.resolve();
      await completed;
      expect(settled).toBe(true);
    }
    expect(storage.state.commits).toBe(3);
  });

  test("identical replay is idempotent without replacing or deleting the target", async () => {
    const storage = databaseDouble();
    await storage.journal().save(record());
    await storage.journal().save(structuredClone(record()));
    await storage.journal().confirm(record());
    expect(storage.state.adds).toBe(1);
    expect(storage.state.values()).toEqual([record()]);
  });

  test("different inputs and requests retain independent immutable targets", async () => {
    const storage = databaseDouble();
    await Promise.all([storage.journal().save(record("a")), storage.journal().save(record("b"))]);
    expect(await storage.journal().get(binding, "input-a")).toEqual(record("a"));
    expect(await storage.journal().get(binding, "input-b")).toEqual(record("b"));
    expect(storage.state.values()).toEqual([record("a"), record("b")]);
  });

  test("concurrent owners cannot overwrite an input, reuse a request, or change any target revision", async () => {
    for (const change of [
      (other: NativeExecutionBrowserRecord) => {
        other.inputId = "another-input";
      },
      (other: NativeExecutionBrowserRecord) => {
        other.requestId = "another-request";
      },
      (other: NativeExecutionBrowserRecord) => {
        other.target.workId = "another-work";
      },
      (other: NativeExecutionBrowserRecord) => {
        other.target.attemptId = "another-attempt";
      },
      ...(["work", "criteria", "attempt"] as const).map(
        (key) => (other: NativeExecutionBrowserRecord) => {
          other.target.expectedRevision[key]++;
        }
      ),
    ]) {
      const storage = databaseDouble();
      const changed = record();
      change(changed);
      const outcomes = await Promise.allSettled([
        storage.journal().save(record()),
        storage.journal().save(changed),
      ]);
      expect(outcomes[0]!.status).toBe("fulfilled");
      expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
      expect(storage.state.values()).toEqual([record()]);
    }
  });

  test("get and confirm isolate exact endpoint, project, principal and transport bindings", async () => {
    const storage = databaseDouble();
    await storage.journal().save(record());
    for (const different of [
      { endpoint: "https://another.example/project" },
      { projectId: "other-project" },
      { principalId: "other-principal" },
      { transport: "relay:public_key" },
      { transport: "relay:another_public_key" },
    ]) {
      const other = { ...binding, ...different };
      expect(await storage.journal().get(other, record().inputId)).toBeNull();
      await expect(
        storage.journal().confirm({ ...record(), binding: other })
      ).rejects.toMatchObject({ code: "missing" });
      const another = { ...record(), binding: other, target: record("other").target };
      await storage.journal().save(another);
      expect(await storage.journal().get(other, record().inputId)).toEqual(another);
    }
    expect(await storage.journal().get(binding, record().inputId)).toEqual(record());
  });

  test("missing get is null, but confirm cannot recreate a missing or changed target", async () => {
    const storage = databaseDouble();
    expect(await storage.journal().get(binding, record().inputId)).toBeNull();
    await expect(storage.journal().confirm(record())).rejects.toMatchObject({ code: "missing" });
    expect(storage.state.adds).toBe(0);
    await storage.journal().save(record());
    expect(await storage.journal().get(binding, "unknown-input")).toBeNull();
    for (const changed of [
      { ...record(), requestId: "changed-request" },
      { ...record(), target: { ...record().target, workId: "changed-work" } },
      { ...record(), target: { ...record().target, attemptId: "changed-attempt" } },
      {
        ...record(),
        target: { ...record().target, expectedRevision: { work: 4, criteria: 2, attempt: 1 } },
      },
    ])
      await expect(storage.journal().confirm(changed)).rejects.toMatchObject({ code: "conflict" });
    expect(storage.state.values()).toEqual([record()]);
  });

  test("rejects bearer fields, extra authority and malformed identities before opening storage", async () => {
    const storage = databaseDouble();
    const invalid: unknown[] = [
      null,
      [],
      new Date(),
      ...["bearer", "token", "authority", "grant", "sourceRevision", "createdAt"].map((key) => ({
        ...record(),
        [key]: "injected",
      })),
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
        "https://daemon.example/" + "a".repeat(2048),
      ].map((endpoint) => ({ ...record(), binding: { ...binding, endpoint } })),
      ...[
        "relay:public:key:rid",
        "relay:",
        "relay:https://relay.example?rid=secret",
        "Bearer secret",
      ].map((transport) => ({ ...record(), binding: { ...binding, transport } })),
      ...["projectId", "principalId"].flatMap((key) =>
        ["", " ", "x".repeat(201)].map((value) => ({
          ...record(),
          binding: { ...binding, [key]: value },
        }))
      ),
      ...["inputId", "requestId"].flatMap((key) =>
        ["", "x".repeat(201), null, 1].map((value) => ({ ...record(), [key]: value }))
      ),
      ...[
        "actorId",
        "projectId",
        "proof",
        "source",
        "receipt",
        "criteria",
        "decision",
        "token",
        "grant",
      ].map((key) => ({ ...record(), target: { ...record().target, [key]: "injected" } })),
      ...["workId", "attemptId"].flatMap((key) =>
        ["", "x".repeat(201), null, 1].map((value) => ({
          ...record(),
          target: { ...record().target, [key]: value },
        }))
      ),
      ...[null, undefined, [], {}, { work: 1, criteria: 2, attempt: 3, proof: "injected" }].map(
        (expectedRevision) => ({ ...record(), target: { ...record().target, expectedRevision } })
      ),
      ...["work", "criteria", "attempt"].flatMap((key) =>
        [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null].map((value) => ({
          ...record(),
          target: {
            ...record().target,
            expectedRevision: { ...record().target.expectedRevision, [key]: value },
          },
        }))
      ),
      {
        ...record(),
        target: {
          ...record().target,
          expectedRevision: Object.assign(new Date(), record().target.expectedRevision),
        },
      },
    ];
    for (const input of invalid) {
      await expect(
        storage.journal().save(input as NativeExecutionBrowserRecord)
      ).rejects.toMatchObject({ code: "invalid-record" });
      await expect(
        storage.journal().confirm(input as NativeExecutionBrowserRecord)
      ).rejects.toMatchObject({ code: "invalid-record" });
    }
    expect(storage.state.opens).toBe(0);
  });

  test("get validates binding and input identity before opening storage", async () => {
    const storage = databaseDouble();
    await expect(
      storage.journal().get({ ...binding, transport: "Bearer secret" }, "input-1")
    ).rejects.toMatchObject({ code: "invalid-record" });
    for (const input of ["", "x".repeat(201), 1, null])
      await expect(storage.journal().get(binding, input as string)).rejects.toMatchObject({
        code: "invalid-record",
      });
    expect(storage.state.opens).toBe(0);
  });

  test("rejects nested hidden and symbol properties and getters without evaluating them", async () => {
    const storage = databaseDouble();
    let accessed = false;
    for (const scope of ["record", "binding", "target", "revision"] as const) {
      for (const kind of ["accessor", "hidden", "symbol", "prototype"] as const) {
        const candidate = record();
        const object =
          scope === "record"
            ? candidate
            : scope === "binding"
              ? candidate.binding
              : scope === "target"
                ? candidate.target
                : candidate.target.expectedRevision;
        const key =
          scope === "record"
            ? "inputId"
            : scope === "binding"
              ? "principalId"
              : scope === "target"
                ? "workId"
                : "work";
        if (kind === "accessor")
          Object.defineProperty(object, key, {
            get() {
              accessed = true;
              return "secret";
            },
          });
        else if (kind === "hidden") Object.defineProperty(object, "token", { value: "secret" });
        else if (kind === "symbol")
          Object.defineProperty(object, Symbol("token"), { value: "secret" });
        else Object.setPrototypeOf(object, { token: "secret" });
        await expect(storage.journal().save(candidate)).rejects.toMatchObject({
          code: "invalid-record",
        });
      }
    }
    expect(accessed).toBe(false);
    expect(storage.state.opens).toBe(0);
  });

  test("retains every target at record capacity across bindings without eviction", async () => {
    const storage = databaseDouble();
    const originals = Array.from(
      { length: NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS },
      (_, index) => record(String(index))
    );
    storage.state.seed(originals);
    const extra = { ...record("extra"), binding: { ...binding, principalId: "another-principal" } };
    await expect(storage.journal().save(extra)).rejects.toMatchObject({ code: "capacity" });
    await storage.journal().save(originals[0]!);
    await storage.journal().confirm(originals[0]!);
    expect(await storage.journal().get(binding, originals[0]!.inputId)).toEqual(originals[0]);
    expect(storage.state.values()).toEqual(originals);
    expect(storage.state.adds).toBe(0);
  });

  test("enforces encoded-byte capacity without truncation, eviction or rewriting", async () => {
    const storage = databaseDouble();
    const large = record();
    large.binding.endpoint = "https://daemon.example/" + "\u0001".repeat(2000);
    large.binding.projectId = "\u0001".repeat(200);
    large.binding.principalId = "\u0001".repeat(200);
    large.target.workId = "\u0001".repeat(200);
    large.target.attemptId = "\u0001".repeat(200);
    const originals: NativeExecutionBrowserRecord[] = [];
    let bytes = 0;
    while (true) {
      const next = {
        ...large,
        inputId: `input-${originals.length}`,
        requestId: `request-${originals.length}`,
      };
      const size = new TextEncoder().encode(JSON.stringify(next)).byteLength;
      if (bytes + size > NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_BYTES) {
        storage.state.seed(originals);
        await expect(storage.journal().save(next)).rejects.toMatchObject({ code: "capacity" });
        break;
      }
      originals.push(next);
      bytes += size;
    }
    expect(originals.length).toBeLessThan(NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS);
    expect(storage.state.values()).toEqual(originals);
    storage.state.seed([...originals, { ...large, inputId: "overflow", requestId: "overflow" }]);
    await expect(storage.journal().get(binding, record().inputId)).rejects.toMatchObject({
      code: "capacity",
    });
  });

  test("never treats corrupt, duplicate or over-limit persisted data as a missing target", async () => {
    for (const existing of [
      [{ ...record(), target: { ...record().target, workId: "" } }],
      [{ ...record(), token: "unexpected" }],
      [{ ...record(), binding: { ...binding, principalId: "other" }, token: "unexpected" }],
      [record(), record()],
      [record(), { ...record(), inputId: "different-input" }],
      [record(), { ...record(), requestId: "different-request" }],
      Array.from({ length: NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS + 1 }, (_, index) =>
        record(String(index))
      ),
    ]) {
      const storage = databaseDouble();
      storage.state.seed(existing);
      for (const operation of [
        () => storage.journal().get(binding, record().inputId),
        () => storage.journal().save(record("new")),
        () => storage.journal().confirm(record()),
      ])
        await expect(operation()).rejects.toBeInstanceOf(Error);
      expect(storage.state.values()).toEqual(existing);
      expect(storage.state.adds).toBe(0);
    }
  });

  test("fails closed on open, schema, read, strict-durability and commit failures", async () => {
    for (const failure of [
      "openError",
      "openThrow",
      "blocked",
      "upgradeError",
      "transactionError",
      "readError",
      "commitError",
      "badSchema",
      "badRequestSchema",
      "nonUniqueRequest",
      "indexError",
      "addRequestError",
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

  test("keeps previous targets when quota or transaction completion fails", async () => {
    for (const failure of ["addError", "addRequestError", "commitError"] as const) {
      const storage = databaseDouble();
      await storage.journal().save(record());
      storage.state[failure] = true;
      await expect(storage.journal().save(record("new"))).rejects.toBeInstanceOf(Error);
      expect(storage.state.values()).toEqual([record()]);
      storage.state[failure] = false;
      await storage.journal().confirm(record());
    }
  });

  test("get and confirm cannot acknowledge reads whose transaction later fails", async () => {
    const storage = databaseDouble();
    await storage.journal().save(record());
    storage.state.commitError = true;
    await expect(storage.journal().get(binding, record().inputId)).rejects.toMatchObject({
      code: "durability",
    });
    await expect(storage.journal().confirm(record())).rejects.toMatchObject({ code: "durability" });
    expect(storage.state.values()).toEqual([record()]);
  });

  test("unavailable IndexedDB fails without a localStorage fallback", async () => {
    const indexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const localStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let fallback = false;
    try {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          fallback = true;
          throw new Error("Forbidden fallback");
        },
      });
      await expect(createNativeExecutionBrowserJournal().save(record())).rejects.toMatchObject({
        code: "unavailable",
      });
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        get() {
          throw new Error("Storage disabled");
        },
      });
      await expect(
        createNativeExecutionBrowserJournal().get(binding, record().inputId)
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(fallback).toBe(false);
    } finally {
      if (indexedDB) Object.defineProperty(globalThis, "indexedDB", indexedDB);
      else Reflect.deleteProperty(globalThis, "indexedDB");
      if (localStorage) Object.defineProperty(globalThis, "localStorage", localStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
