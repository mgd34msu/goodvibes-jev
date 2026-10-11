import { afterEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteObservationRetiredError, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
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
