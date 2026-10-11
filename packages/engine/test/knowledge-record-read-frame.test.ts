import { afterEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlJsEngine, SQLiteObservationRetiredError, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeRecordAdmissionHeldError, prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], databases: SQLiteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() { const root = mkdtempSync(join(tmpdir(), 'knowledge-read-frame-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
function instrument(sqlite: SQLiteStore) {
  const internal = sqlite as unknown as { openCurrentImage(): SqlDatabase; openPrivateReadImage(): SqlDatabase; closeReadImage(db: SqlDatabase): void };
  const currentImages = new Set<SqlDatabase>(), privateImages = new Set<SqlDatabase>();
  const open = internal.openCurrentImage.bind(sqlite); let opened = 0, closed = 0;
  spyOn(internal, 'openCurrentImage').mockImplementation(() => {
    opened++; const db = open(); currentImages.add(db); return db;
  });
  const privateOpen = internal.openPrivateReadImage.bind(sqlite); let privateOpened = 0, privateClosed = 0;
  spyOn(internal, 'openPrivateReadImage').mockImplementation(() => {
    privateOpened++; const db = privateOpen(); privateImages.add(db); return db;
  });
  // Count the same cleanup calls without overwriting frozen facade methods.
  const close = internal.closeReadImage.bind(sqlite);
  spyOn(internal, 'closeReadImage').mockImplementation(db => {
    if (currentImages.has(db)) closed++;
    if (privateImages.has(db)) privateClosed++;
    close(db);
  });
  return Object.assign(() => ({ opened, closed }), { privateImages: () => ({ opened: privateOpened, closed: privateClosed }) });
}
async function fixture(filename = path(), observeValidation?: (db: SqlDatabase) => void) {
  // KnowledgeStore starts init in its constructor. Install the observation
  // before construction, preserving the real schema validator and its options.
  const init = SQLiteStore.prototype.init;
  const observing = observeValidation ? spyOn(SQLiteStore.prototype, 'init').mockImplementation(function (this: SQLiteStore, schema, options) {
    return init.call(this, schema, {
      ...options, validateCurrentSchema(db) { options?.validateCurrentSchema?.(db); observeValidation(db); },
    });
  }) : undefined;
  let store: KnowledgeStore;
  try { store = new KnowledgeStore({ dbPath: filename }); }
  finally { observing?.mockRestore(); }
  stores.push(store);
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  const source = await store.upsertSource({ id: 'source', connectorId: 'frame-test', sourceType: 'document',
    title: 'Router operations', status: 'indexed', metadata: { knowledgeSpaceId: 'default', nested: { original: 'complete' } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'frame-test', format: 'text',
    sections: ['Router reference'], metadata: { knowledgeSpaceId: 'default' } });
  return { store, source, extraction, sqlite };
}
async function database() {
  const filename = path(), sqlite = new SQLiteStore(filename, { coordinated: true }); databases.push(sqlite);
  await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS knowledge_sources (id TEXT)'));
  await sqlite.save();
  return { sqlite, filename };
}
const read = (sqlite: SQLiteStore) => sqlite.readPersistedRow('knowledge_sources', 'id', 'pending direct change');

test('cached closed rows are detached on every read and cannot cross a synchronous frame', async () => {
  const { sqlite } = await database();
  sqlite.run("INSERT INTO knowledge_sources VALUES ('original')"); await sqlite.save();
  sqlite.assertPersistedReadFrame(() => {
    const first = sqlite.readPersistedRow('knowledge_sources', 'id', 'original');
    first[0]!.columns[0] = 'borrowed mutation'; first[0]!.values[0]![0] = 'borrowed mutation';
    first[0]!.values.push(['injected']);
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'original')).toEqual([{ columns: ['id'], values: [['original']] }]);
  });
  sqlite.run("UPDATE knowledge_sources SET id = 'replacement'"); await sqlite.save();
  sqlite.assertPersistedReadFrame(() => {
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'original')).toEqual([]);
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'replacement')).toEqual([{ columns: ['id'], values: [['replacement']] }]);
  });
});

test('generation-only guards match complete snapshots and retain raw stored bytes', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  let originalSource: string | null = null, originalExtraction: string | null = null;
  store.assertRecordSnapshotFrame(() => {
    originalSource = store.getSourceGeneration(source.id);
    originalExtraction = store.getRecordGeneration('extraction', extraction.id);
    expect(originalSource).toBe(store.getSourceSnapshot({ id: source.id }).generation);
    expect(originalExtraction).toBe(store.getRecordSnapshot('extraction', extraction.id).generation);
    expect(store.getRecordGeneration('node', 'missing')).toBeNull();
  });
  const rawMetadata = String(store.getSourceSnapshot({ id: source.id }).raw!.metadata);
  sqlite.run('UPDATE knowledge_sources SET metadata = ? WHERE id = ?', [` ${rawMetadata}`, source.id]);
  await sqlite.save();
  store.assertRecordSnapshotFrame(() => {
    expect(store.getSourceGeneration(source.id)).not.toBe(originalSource);
    expect(store.getSourceSnapshot({ id: source.id }).source?.metadata).toEqual(source.metadata);
    expect(store.getRecordGeneration('extraction', extraction.id)).toBe(originalExtraction);
  });
  expect(store.getSource(source.id)).toBe(source);
});

test('a memoized raw generation retires before reuse after a retained writer restores the row', async () => {
  let writer: SqlDatabase | undefined;
  const { store, source, sqlite } = await fixture();
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const original = store.getSourceSnapshot({ id: source.id }).raw!;
  let reused = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    const generation = store.getSourceGeneration(source.id);
    expect(store.getSourceGeneration(source.id)).toBe(generation);
    writer!.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', ['temporary meaning', source.id]);
    writer!.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
    store.getSourceGeneration(source.id);
    reused = true;
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(reused).toBe(false);
  expect(store.getSourceSnapshot({ id: source.id }).raw).toEqual(original);
});

test('an admitted mutable record keeps its full descriptor fence after generation-only checks', async () => {
  const { store, extraction } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); receipt.assertCurrent(); });
  Object.defineProperty(extraction.sections, 'extraMeaning', { value: 'new protected input', enumerable: true });
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).toThrow(KnowledgeRecordAdmissionHeldError);
});

test('an actual native VFS alias replacement and restore retires the original raw generation', async () => {
  const { store, source, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  let consumed = false;
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(alias.exec('SELECT title FROM original.knowledge_sources WHERE id = ?', [source.id])[0]?.values[0]?.[0]).toBe(source.title);
    expect(() => store.assertRecordSnapshotFrame(() => {
      const original = store.getSourceGeneration(source.id);
      expect(store.getSourceGeneration(source.id)).toBe(original);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['native alias replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
      store.getSourceGeneration(source.id);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(consumed).toBe(false);
    expect(store.getSourceSnapshot({ id: source.id }).source?.summary).toBe(source.summary);
  } finally { alias.close(); }
});

test('closed generation batches match every original row and retire native alias restore before returning', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const selectors = [{ kind: 'source' as const, id: source.id }, { kind: 'extraction' as const, id: extraction.id }, { kind: 'node' as const, id: 'missing' }];
  let consumed = false;
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(alias.exec('SELECT title FROM original.knowledge_sources WHERE id = ?', [source.id])[0]?.values[0]?.[0]).toBe(source.title);
    expect(() => store.assertRecordSnapshotFrame(() => {
      const expected = [store.getSourceSnapshot({ id: source.id }).generation, store.getRecordSnapshot('extraction', extraction.id).generation, null];
      expect(store.getRecordGenerations(selectors)).toEqual(expected);
      expect(Object.isFrozen(store.getRecordGenerations(selectors))).toBe(true);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['batch alias replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
      store.getRecordGenerations(selectors);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(consumed).toBe(false);
  } finally { alias.close(); }
});

test.each(['selector-accessor', 'index-accessor', 'named-array'] as const)('generation batch rejects %s before reading any raw image', async mode => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }];
  let getterCalls = 0;
  if (mode === 'selector-accessor') Object.defineProperty(selectors[0], 'id', { get() { getterCalls++; return source.id; }, enumerable: true });
  if (mode === 'index-accessor') Object.defineProperty(selectors, '0', { get() { getterCalls++; return { kind: 'source', id: source.id }; }, enumerable: true });
  if (mode === 'named-array') Object.defineProperty(selectors, 'meaning', { value: 'unselected extra', enumerable: true });
  const snapshots = instrument(sqlite);
  expect(() => store.getRecordGenerations(selectors)).toThrow(TypeError);
  expect(getterCalls).toBe(0);
  expect(snapshots()).toEqual({ opened: 0, closed: 0 });
  expect(snapshots.privateImages()).toEqual({ opened: 0, closed: 0 });
});

test('the all-cached generation batch exit fence retires an actual native alias restore before returning', async () => {
  const { store, source, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const observers: { mockRestore(): void }[] = [];
  let replaced = false, consumed = false;
  alias.run('ATTACH DATABASE ? AS original', [main]);
  try {
    expect(() => store.assertRecordSnapshotFrame(() => {
      const selectors = [{ kind: 'source' as const, id: source.id }];
      store.getRecordGenerations(selectors);
      const frame: unknown = Reflect.get(sqlite, 'persistedReadFrame');
      if (!frame || typeof frame !== 'object') throw new Error('No original synchronous read frame');
      const memo: unknown = Reflect.get(frame, 'generations');
      if (!(memo instanceof Map)) throw new Error('No original generation memo');
      const read = memo.get.bind(memo), key = JSON.stringify(['knowledge_sources', 'id', source.id]);
      observers.push(spyOn(memo, 'get').mockImplementation(entry => {
        const generation: unknown = read(entry);
        if (!replaced && entry === key) {
          replaced = true;
          alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['during cached batch replacement', source.id]);
          alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
        }
        return generation;
      }));
      store.getRecordGenerations(selectors);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(replaced).toBe(true);
    expect(consumed).toBe(false);
  } finally { for (const observer of observers) observer.mockRestore(); alias.close(); }
});

test('the closed generation batch exit fence catches an actual native alias restore during its SQL read', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const internal = sqlite as unknown as { readPrivatePersistedRows(sql: string, params: string[], closed?: boolean): ReturnType<SqlDatabase['exec']> };
  const read = internal.readPrivatePersistedRows.bind(sqlite);
  let replaced = false, consumed = false;
  alias.run('ATTACH DATABASE ? AS original', [main]);
  const observing = spyOn(internal, 'readPrivatePersistedRows').mockImplementation((sql, params, closed) => {
    const result = read(sql, params, closed);
    if (!replaced && sql === 'SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1') {
      replaced = true;
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['during batch replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
    }
    return result;
  });
  try {
    expect(() => store.getRecordGenerations([{ kind: 'source', id: source.id }, { kind: 'extraction', id: extraction.id }])
      && (consumed = true)).toThrow(SQLiteObservationRetiredError);
    expect(replaced).toBe(true);
    expect(consumed).toBe(false);
  } finally { observing.mockRestore(); alias.close(); }
});

test('physical edge generation reads retain exact original raw metadata without decoded views', async () => {
  const { store, source, sqlite } = await fixture();
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'bounded-node',
    relation: 'documents', weight: 0.75, metadata: { complete: 'raw' } });
  const original = store.getEdgeSnapshot(edge.id);
  store.assertRecordSnapshotFrame(() => {
    expect(store.getEdgeGenerationSnapshots().find(snapshot => snapshot.id === edge.id)).toEqual({ id: edge.id,
      fromKind: edge.fromKind, fromId: edge.fromId, toKind: edge.toKind, toId: edge.toId, generation: original.generation! });
  });
  sqlite.run('UPDATE knowledge_edges SET metadata = ? WHERE id = ?', [' {"complete":"raw"}', edge.id]);
  await sqlite.save();
  store.assertRecordSnapshotFrame(() => {
    const changed = store.getEdgeSnapshot(edge.id);
    expect(changed.record?.metadata).toEqual(edge.metadata);
    const generation = store.getEdgeGenerationSnapshots().find(snapshot => snapshot.id === edge.id)?.generation ?? null;
    expect(generation).toBe(changed.generation);
    expect(changed.generation).not.toBe(original.generation);
  });
});

test('real admission and nested semantic guard read every full row from one image per invocation', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const sourceAdmission = prepareKnowledgeRecordAdmission(store, 'source', source);
  const extractionAdmission = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const guard = createSemanticWriteGuard(store);
  guard.watch('admitted-records', () => { sourceAdmission.assertCurrent(); extractionAdmission.assertCurrent(); return true; });
  const snapshots = instrument(sqlite);
  store.assertRecordSnapshotFrame(() => {
    for (let i = 0; i < 8; i++) { guard.assertCurrent(); sourceAdmission.assertCurrent(); }
    expect(JSON.parse(String(store.getSourceSnapshot({ id: source.id }).raw?.metadata))).toEqual(source.metadata);
    expect(store.getSource(source.id)).toBe(source);
    expect(typeof source.createdAt).toBe('number');
  });
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  expect(snapshots.privateImages()).toEqual({ opened: 1, closed: 1 });
  await Promise.resolve(); guard.assertCurrent();
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
  await store.replaceSourceRecord({ ...source, summary: 'changed' });
  await store.replaceSourceRecord(source);
  expect(store.getSource(source.id)).toEqual(source); expect(store.getSource(source.id)).not.toBe(source);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  expect(snapshots()).toEqual({ opened: 3, closed: 3 });
});

test('independent admission guard sees persisted extraction changes without adopting cached source identity', async () => {
  const { store, extraction, sqlite } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); });
  sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["new raw evidence"]', extraction.id]);
  await sqlite.save();
  expect(store.getExtraction(extraction.id)).toBe(extraction);
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).toThrow(KnowledgeRecordAdmissionHeldError);
});

test('throws and swallowed nested misuse retire and close the frame before an independent read', async () => {
  const { sqlite } = await database(); const snapshots = instrument(sqlite);
  expect(() => sqlite.assertPersistedReadFrame(() => { read(sqlite); throw new Error('caller failure'); })).toThrow('caller failure');
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    try { sqlite.assertPersistedReadFrame(() => { throw new Error('nested failure'); }); } catch { /* cannot revive frame */ }
  })).toThrow(SQLiteObservationRetiredError);
  read(sqlite); expect(snapshots()).toEqual({ opened: 3, closed: 3 });
});

test('async return is rejected and its continuation cannot inherit a frame', async () => {
  const { sqlite } = await database(); const snapshots = instrument(sqlite);
  let continuation: Promise<void> | undefined;
  const unsupported = () => {
    read(sqlite);
    continuation = Promise.resolve().then(() => { read(sqlite); });
    return continuation;
  };
  expect(() => sqlite.assertPersistedReadFrame(unsupported as unknown as () => undefined)).toThrow(TypeError);
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  await continuation;
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
});

test('local revision ABA is rejected even when the complete local bytes are restored', async () => {
  const { sqlite } = await database(); const before = sqlite.readPersisted(db => Buffer.from(db.export()));
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite); sqlite.run("INSERT INTO knowledge_sources VALUES ('temporary')"); sqlite.run('DELETE FROM knowledge_sources');
  })).toThrow(SQLiteObservationRetiredError);
  expect(sqlite.readPersisted(db => Buffer.from(db.export()))).toEqual(before);
});

test('identical-byte external file replacement retires the current frame and the next guard opens fresh', async () => {
  const { sqlite, filename } = await database(); const snapshots = instrument(sqlite);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite); copyFileSync(filename, `${filename}.replacement`); renameSync(`${filename}.replacement`, filename);
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
});

test('semantic guard preserves cancellation and translates a synchronous raw-read mutation to a typed stale hold', async () => {
  const { store, source, sqlite } = await fixture();
  const controller = new AbortController(), guard = createSemanticWriteGuard(store, controller.signal);
  let mutate = false;
  guard.watch('source-raw', () => {
    const snapshot = store.getSourceSnapshot({ id: source.id });
    if (mutate) sqlite.run("UPDATE knowledge_sources SET summary = 'pending local change' WHERE id = ?", [source.id]);
    return snapshot;
  });
  mutate = true;
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  mutate = false; controller.abort();
  let failure: unknown; try { guard.assertCurrent(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(KnowledgeSourceQualityHeldError);
  expect((failure as KnowledgeSourceQualityHeldError).reason).toBe('aborted');
});

test('full local-content fence catches untracked raw-image mutation without replacing pending local state', async () => {
  const { sqlite } = await database();
  const local = (sqlite as unknown as { db: SqlDatabase }).db;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite); local.run("INSERT INTO knowledge_sources VALUES ('pending direct change')");
  })).toThrow(SQLiteObservationRetiredError);
  expect(local.exec('SELECT id FROM knowledge_sources')[0]?.values).toEqual([['pending direct change']]);
  expect(read(sqlite)).toEqual([]);
});

test('a caught async nested misuse still prevents outer success', async () => {
  const { sqlite } = await database(); const snapshots = instrument(sqlite);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    try { sqlite.assertPersistedReadFrame((() => Promise.resolve()) as unknown as () => undefined); } catch { /* invalid nested frame */ }
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
});

test('mutable legacy callbacks cannot restore obsolete evidence inside the shared admission image', async () => {
  const { store, extraction, sqlite } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const oldSections = store.getRecordSnapshot('extraction', extraction.id).raw!.sections as string;
  sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["changed persisted evidence"]', extraction.id]);
  await sqlite.save();
  let callbackReached = false, admitted = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    // Acquire the frame before a legacy mutable read tries to contaminate it.
    store.getRecordSnapshot('extraction', extraction.id);
    sqlite.readPersisted(db => {
      callbackReached = true;
      db.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', [oldSections, extraction.id]);
      try { receipt.assertCurrent(); admitted = true; }
      finally {
        // Mutation then restoration must not evade the admission boundary.
        db.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["changed persisted evidence"]', extraction.id]);
      }
    });
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(callbackReached).toBe(true); expect(admitted).toBe(false);
  expect(store.getRecordSnapshot('extraction', extraction.id).raw?.sections).toBe('["changed persisted evidence"]');
  expect(store.getExtraction(extraction.id)).toBe(extraction);
});

test('invalid descriptor attempts cannot inject SQL or revive a caught active frame', async () => {
  const { sqlite } = await database();
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    try { sqlite.readPersistedRow('knowledge_sources; DELETE FROM knowledge_sources' as 'knowledge_sources', 'id', 'x'); }
    catch { /* rejected attempts poison the entire assertion */ }
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
});


test('ephemeral legacy transaction mutation and rollback cannot hide behind an earlier frame image', async () => {
  const { store, extraction, sqlite } = await fixture(':memory:');
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const before = store.getRecordSnapshot('extraction', extraction.id).raw;
  let mutated = false, admitted = false, rolledBack = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    receipt.assertCurrent();
    sqlite.readPersisted(db => {
      db.run('BEGIN');
      try {
        db.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["transient evidence"]', extraction.id]);
        mutated = true;
        receipt.assertCurrent(); admitted = true;
      } finally { db.run('ROLLBACK'); rolledBack = true; }
    });
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(mutated).toBe(true); expect(rolledBack).toBe(true); expect(admitted).toBe(false);
  expect(store.getRecordSnapshot('extraction', extraction.id).raw).toEqual(before);
  // A separate invocation is fresh and may admit the truly restored current row.
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).not.toThrow();
});


test('ephemeral admission stays live for mutable handles retained before an assertion', async () => {
  const { store, extraction, sqlite } = await fixture(':memory:');
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const retained = sqlite.readPersisted(db => db);
  const before = store.getRecordSnapshot('extraction', extraction.id).raw;
  let admitted = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    receipt.assertCurrent();
    retained.run('BEGIN');
    try {
      retained.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["retained handle evidence"]', extraction.id]);
      receipt.assertCurrent(); admitted = true;
    } finally { retained.run('ROLLBACK'); }
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(admitted).toBe(false);
  expect(store.getRecordSnapshot('extraction', extraction.id).raw).toEqual(before);
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).not.toThrow();
});

test('nested file-backed guards detect mutations through a legitimately retained writer handle', async () => {
  const { sqlite } = await database(); let retained: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    retained = db; db.run("INSERT INTO knowledge_sources VALUES ('original')");
    return { changed: true, value: undefined };
  }, () => {});
  if (!retained) throw new Error('Writer handle was not captured');
  const handle = retained;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    handle.run('BEGIN');
    try {
      handle.run("UPDATE knowledge_sources SET id = 'transient'");
      sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    } finally { handle.run('ROLLBACK'); }
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
});

test.each(['mode', 'attachment', 'export'] as const)('a retained facade %s operation invalidates the private image before a nested read', async operation => {
  const { sqlite } = await database(); let retained: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    retained = db; db.run("INSERT INTO knowledge_sources VALUES ('original')");
    return { changed: true, value: undefined };
  }, () => {});
  if (!retained) throw new Error('Writer handle was not captured');
  const handle = retained; let consumed = false;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    if (operation === 'mode') handle.exec('PRAGMA read_uncommitted=1');
    else if (operation === 'attachment') handle.exec("ATTACH DATABASE ':memory:' AS external");
    else handle.export();
    sqlite.assertPersistedReadFrame(() => { read(sqlite); consumed = true; });
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false);
});


test('a supported validation callback cannot retain the private admission image', async () => {
  const observed: SqlDatabase[] = [];
  const { store, extraction, sqlite } = await fixture(path(), db => { observed.push(db); });
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const snapshots = instrument(sqlite);
  store.assertRecordSnapshotFrame(() => {
    receipt.assertCurrent();
    const exposed = observed.at(-1);
    if (!exposed) throw new Error('Validation callback was not invoked');
    // The callback-exposed image is closed before the receipt can reuse the
    // private clone. Mutation/restoration through that handle is impossible.
    expect(() => exposed.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?',
      ['["forged callback evidence"]', extraction.id])).toThrow();
    receipt.assertCurrent();
    expect(store.getRecordSnapshot('extraction', extraction.id).record).toEqual(extraction);
  });
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  expect(snapshots.privateImages()).toEqual({ opened: 1, closed: 1 });
});
