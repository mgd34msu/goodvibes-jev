/**
 * DaemonCardStore: the metadata/material split, and the properties that split
 * exists to hold.
 *
 * The assertions that matter here are the negative ones. A card store is easy to
 * write so that it works and leaks: the number ends up in the metadata file
 * "just for the brand", or an error message quotes the value that failed to
 * store. Every test below that reads a file or an error is checking for the
 * absence of a sentinel, which is why the sentinel is a distinctive string
 * rather than a plausible card number.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CARD_MATERIAL_FIELDS,
  CardStoreUnreadableError,
  DaemonCardStore,
  cardBrand,
  cardSecretKey,
  newCardId,
  type CardCreateInput,
  type CvvHandling,
  type PaymentsSecretStore,
} from '../sdk/src/platform/payments/host/card-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

/** A number nothing could mistake for anything else, so a leak is unambiguous. */
const SENTINEL_NUMBER = '4111111111111111';
const SENTINEL_CVV = '907';
const SENTINEL_HOLDER = 'SENTINEL CARDHOLDER';

/** An in-memory secret tier. Records every write so a test can inspect the keys. */
function memorySecrets(): PaymentsSecretStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function cardInput(overrides: Partial<CardCreateInput> = {}): CardCreateInput {
  return {
    label: 'daily driver',
    kind: 'virtual',
    number: SENTINEL_NUMBER,
    expiryMonth: 7,
    expiryYear: 2029,
    cvv: SENTINEL_CVV,
    cardholderName: SENTINEL_HOLDER,
    issuerCapMinorUnits: 25000,
    ...overrides,
  };
}

let filePath = '';
let secrets: ReturnType<typeof memorySecrets>;
let cvvHandling: CvvHandling = 'stored';

function makeStore(): DaemonCardStore {
  return new DaemonCardStore({
    filePath,
    secrets,
    cvvHandling: () => cvvHandling,
  });
}

beforeEach(() => {
  filePath = join(makeProjectTempDir('gv-payments-cards'), 'payments-cards.json');
  secrets = memorySecrets();
  cvvHandling = 'stored';
});

describe('DaemonCardStore: what lands where', () => {
  test('the metadata file holds no part of the card material', async () => {
    const store = makeStore();
    await store.create(cardInput());
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).not.toContain(SENTINEL_NUMBER);
    expect(onDisk).not.toContain(SENTINEL_CVV);
    expect(onDisk).not.toContain(SENTINEL_HOLDER);
    // What it DOES hold: the four digits that make a statement reconcilable.
    expect(onDisk).toContain('"last4": "1111"');
  });

  test('every material field lands in the secret tier under its derived key', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    for (const field of CARD_MATERIAL_FIELDS) {
      expect(secrets.values.has(cardSecretKey(card.id, field)), `${field} was not written`).toBe(true);
    }
    expect(secrets.values.get(cardSecretKey(card.id, 'number'))).toBe(SENTINEL_NUMBER);
    // The expiry month is padded at write time so a checkout field gets "07",
    // not "7", whichever call site reads it.
    expect(secrets.values.get(cardSecretKey(card.id, 'expiryMonth'))).toBe('07');
    expect(secrets.values.get(cardSecretKey(card.id, 'expiryYear'))).toBe('2029');
  });

  test('the derived key carries the card id, so two cards never share a secret', async () => {
    const store = makeStore();
    const first = await store.create(cardInput({ label: 'one' }));
    const second = await store.create(cardInput({ label: 'two', number: '5500005555555559' }));
    expect(first.id).not.toBe(second.id);
    expect(cardSecretKey(first.id, 'number')).not.toBe(cardSecretKey(second.id, 'number'));
    expect(secrets.values.get(cardSecretKey(second.id, 'number'))).toBe('5500005555555559');
    expect(secrets.values.get(cardSecretKey(first.id, 'number'))).toBe(SENTINEL_NUMBER);
  });

  test('a key follows the daemon secret-key convention', () => {
    expect(cardSecretKey('card-abc123', 'cardholderName'))
      .toBe('GOODVIBES_PAYMENTS_CARD_CARD_ABC123_CARDHOLDER_NAME');
  });
});

describe('DaemonCardStore: reading back', () => {
  test('read returns every field, and only in-process', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    const material = await store.read(card.id);
    expect(material).not.toBeNull();
    expect(material!.number).toBe(SENTINEL_NUMBER);
    expect(material!.cvv).toBe(SENTINEL_CVV);
    expect(material!.cardholderName).toBe(SENTINEL_HOLDER);
    expect(material!.expiryMonth).toBe('07');
    expect(material!.expiryYear).toBe('2029');
  });

  test('read is all-or-nothing: one cleared field means null, not a partial card', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    secrets.values.delete(cardSecretKey(card.id, 'cvv'));
    expect(await store.read(card.id)).toBeNull();
    expect(await store.materialComplete(card.id)).toBe(false);
  });

  test('an unknown card id reads as null rather than as an empty card', async () => {
    const store = makeStore();
    expect(await store.read('card-does-not-exist')).toBeNull();
    expect(await store.metadata('card-does-not-exist')).toBeNull();
    expect(await store.materialComplete('card-does-not-exist')).toBe(false);
  });

  test('materialComplete asks the secret store, not the metadata row', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    expect(await store.materialComplete(card.id)).toBe(true);
    secrets.values.set(cardSecretKey(card.id, 'number'), '');
    expect(await store.materialComplete(card.id)).toBe(false);
  });
});

describe("DaemonCardStore: payments.cvvHandling = 'prompt'", () => {
  test('the CVV is not written, and the card reports itself incomplete', async () => {
    cvvHandling = 'prompt';
    const store = makeStore();
    const card = await store.create(cardInput());
    expect(secrets.values.has(cardSecretKey(card.id, 'cvv'))).toBe(false);
    // Not a degradation: 'CVV not set' is exactly what the descriptor says a
    // surface renders from this flag, and under 'prompt' it is the truth.
    expect(await store.materialComplete(card.id)).toBe(false);
    expect(await store.read(card.id)).toBeNull();
    // Everything else still stored, so the card is usable the moment a CVV is typed.
    expect(secrets.values.get(cardSecretKey(card.id, 'number'))).toBe(SENTINEL_NUMBER);
  });

  test('flipping to prompt stops the store supplying a CVV it already holds', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    expect(await store.materialComplete(card.id)).toBe(true);
    expect((await store.read(card.id))!.cvv).toBe(SENTINEL_CVV);

    // The setting is about what this store will HAND OVER, not only about what
    // it writes. Honoring it at create time alone made it a statement about new
    // cards: this card went on being readable after the owner said stop.
    cvvHandling = 'prompt';
    expect(await store.materialComplete(card.id)).toBe(false);
    expect(await store.read(card.id)).toBeNull();
  });

  test('the stored CVV is not purged, so flipping back restores the card', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    cvvHandling = 'prompt';
    expect(await store.read(card.id)).toBeNull();
    // Still on disk. Destroying the owner's stored data as a side effect of
    // changing a preference is not this module's call; deletion is a verb he asks for.
    expect(secrets.values.get(cardSecretKey(card.id, 'cvv'))).toBe(SENTINEL_CVV);
    cvvHandling = 'stored';
    expect(await store.materialComplete(card.id)).toBe(true);
    expect((await store.read(card.id))!.cvv).toBe(SENTINEL_CVV);
  });

  test('under prompt the other four fields are still supplied and still stored', async () => {
    cvvHandling = 'prompt';
    const store = makeStore();
    const card = await store.create(cardInput());
    expect(secrets.values.get(cardSecretKey(card.id, 'number'))).toBe(SENTINEL_NUMBER);
    expect(secrets.values.get(cardSecretKey(card.id, 'cardholderName'))).toBe(SENTINEL_HOLDER);
  });
});

describe('DaemonCardStore: deletion', () => {
  test('removes the row and counts the secrets it actually cleared', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    const result = await store.remove(card.id);
    expect(result).toEqual({ deleted: true, secretsCleared: 5 });
    expect(store.list()).toEqual([]);
    for (const field of CARD_MATERIAL_FIELDS) {
      expect(secrets.values.has(cardSecretKey(card.id, field))).toBe(false);
    }
  });

  test('a partial deletion is visible in the count rather than silent', async () => {
    cvvHandling = 'prompt';
    const store = makeStore();
    const card = await store.create(cardInput());
    const result = await store.remove(card.id);
    expect(result.deleted).toBe(true);
    // Four, not five: the CVV was never stored, so there was nothing to clear.
    expect(result.secretsCleared).toBe(4);
  });

  test('deleting an unknown id reports deleted:false and clears nothing', async () => {
    const store = makeStore();
    await store.create(cardInput());
    const result = await store.remove('card-not-here');
    expect(result).toEqual({ deleted: false, secretsCleared: 0 });
    expect(store.list()).toHaveLength(1);
  });

  test('deleting one card leaves the others intact', async () => {
    const store = makeStore();
    const first = await store.create(cardInput({ label: 'one' }));
    const second = await store.create(cardInput({ label: 'two' }));
    await store.remove(first.id);
    expect(store.list().map((card) => card.id)).toEqual([second.id]);
    expect(secrets.values.has(cardSecretKey(second.id, 'number'))).toBe(true);
  });
});

describe('DaemonCardStore: failure paths carry no material', () => {
  test('a secret-store failure rolls the write back and reports nothing that was submitted', async () => {
    let writes = 0;
    const failing: PaymentsSecretStore = {
      get: async (key) => secrets.get(key),
      set: async (key, value) => {
        writes += 1;
        if (writes === 3) throw new Error(`the store refused to write ${value}`);
        await secrets.set(key, value);
      },
      delete: async (key) => secrets.delete(key),
    };
    const store = new DaemonCardStore({ filePath, secrets: failing, cvvHandling: () => 'stored' });

    let raised: unknown = null;
    try {
      await store.create(cardInput());
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Error);
    const message = (raised as Error).message;
    // The underlying error quoted the value; the reported one does not.
    expect(message).not.toContain(SENTINEL_NUMBER);
    expect(message).not.toContain(SENTINEL_HOLDER);
    expect(message).toBe('The card could not be written to the daemon secret store.');
    // A failure this method CATCHES is unwound completely, in both directions.
    // The row now goes down first (so a crash leaves something visible and
    // deletable rather than invisible key material), which means the unwind has
    // to take it back out again; the file exists because it was written, and it
    // holds no cards.
    expect(existsSync(filePath)).toBe(true);
    expect(store.list()).toEqual([]);
    expect([...secrets.values.keys()]).toEqual([]);
  });

  test('the state a crash mid-create leaves is visible and deletable, not invisible material', async () => {
    // Reconstructed directly rather than provoked, because a caught failure is
    // unwound (the test above) and only a killed process leaves this. It is the
    // state the write ORDER exists to choose: the row landed, the material was
    // still going down. Row-first makes that recoverable; material-first made
    // the mirror image of it permanently unreachable.
    const store = makeStore();
    const card = await store.create(cardInput({ label: 'interrupted' }));
    for (const field of ['cvv', 'cardholderName'] as const) {
      secrets.values.delete(cardSecretKey(card.id, field));
    }

    const survivor = makeStore();
    // Visible: cards.list shows it, so the owner knows it is there.
    expect(survivor.list().map((entry) => entry.id)).toEqual([card.id]);
    // Honest: it says it cannot be used.
    expect(await survivor.materialComplete(card.id)).toBe(false);
    // Reachable: delete resolves the id through the row and sweeps what landed.
    const swept = await survivor.remove(card.id);
    expect(swept).toEqual({ deleted: true, secretsCleared: 3 });
    expect([...secrets.values.keys()]).toEqual([]);
  });

  test('material stranded with no row is still sweepable by id', async () => {
    // The other half of the same guarantee: remove() clears material even when
    // there is no row, so nothing a crash strands is permanently unreachable.
    const store = makeStore();
    await secrets.set(cardSecretKey('card-orphan', 'number'), SENTINEL_NUMBER);
    await secrets.set(cardSecretKey('card-orphan', 'cvv'), SENTINEL_CVV);
    const result = await store.remove('card-orphan');
    expect(result).toEqual({ deleted: false, secretsCleared: 2 });
    expect([...secrets.values.keys()]).toEqual([]);
  });
});

describe('DaemonCardStore: a damaged file is refused, never read as empty', () => {
  test('the reproduction: a create against a corrupt file must not orphan the cards it cannot see', async () => {
    // Two cards, stored properly.
    const store = makeStore();
    const first = await store.create(cardInput({ label: 'A' }));
    const second = await store.create(cardInput({ label: 'B', number: '5500005555555559' }));
    const keysBefore = [...secrets.values.keys()].sort();
    expect(keysBefore).toHaveLength(10);

    // The file is damaged, by a torn write or a hand edit.
    const damaged = '{"version":1,"cards":[{"id":';
    writeFileSync(filePath, damaged);

    // Adding a third card must REFUSE. Reading the file as empty and writing it
    // back with only the new card is what stranded A's and B's material in the
    // secret tier with no row left to reach it by: cards.list could not show
    // them and cards.delete resolves the id through the row, so nothing this
    // daemon serves could ever have cleared them again.
    let raised: unknown = null;
    try {
      await store.create(cardInput({ label: 'C' }));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(CardStoreUnreadableError);
    expect((raised as Error).message).toContain(filePath);
    expect((raised as Error).message).toContain('Repair the file');

    // Nothing was written, nothing was cleared, nothing was lost.
    expect(readFileSync(filePath, 'utf-8')).toBe(damaged);
    expect([...secrets.values.keys()].sort()).toEqual(keysBefore);

    // And once the operator repairs the file, both cards are exactly as they were.
    writeFileSync(filePath, JSON.stringify({ version: 1, cards: [first, second] }));
    expect(store.list().map((card) => card.id)).toEqual([first.id, second.id]);
    expect(await store.materialComplete(first.id)).toBe(true);
    expect(await store.materialComplete(second.id)).toBe(true);
  });

  test('delete refuses too, rather than clearing material it is about to lose the row for', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    writeFileSync(filePath, 'not json at all');
    await expect(store.remove(card.id)).rejects.toThrow(CardStoreUnreadableError);
    // The material is untouched, so the card is whole again the moment the file is.
    for (const field of CARD_MATERIAL_FIELDS) {
      expect(secrets.values.has(cardSecretKey(card.id, field))).toBe(true);
    }
  });

  test('every read path refuses rather than reporting the cards as gone', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    writeFileSync(filePath, '{"version":1,"cards":"not an array"}');
    expect(() => store.list()).toThrow(CardStoreUnreadableError);
    await expect(store.metadata(card.id)).rejects.toThrow(CardStoreUnreadableError);
    await expect(store.materialComplete(card.id)).rejects.toThrow(CardStoreUnreadableError);
    // null would claim this store had checked whether the card is configured.
    await expect(store.read(card.id)).rejects.toThrow(CardStoreUnreadableError);
  });

  test('an absent file is a legitimately empty store, not damage', async () => {
    const store = makeStore();
    expect(store.list()).toEqual([]);
    // And it stays writable: this is the first-card path on a fresh daemon.
    await store.create(cardInput());
    expect(store.list()).toHaveLength(1);
  });

  test('a well-formed document with no cards key is empty, not damage', async () => {
    writeFileSync(filePath, '{"version":1}');
    const store = makeStore();
    expect(store.list()).toEqual([]);
    await store.create(cardInput());
    expect(store.list()).toHaveLength(1);
  });
});

describe('card metadata derived at write time', () => {
  test.each([
    ['4111111111111111', 'visa'],
    ['5500005555555559', 'mastercard'],
    ['2223000048400011', 'mastercard'],
    ['378282246310005', 'amex'],
    ['6011111111111117', 'discover'],
    ['30569309025904', 'diners'],
    ['3530111333300000', 'jcb'],
    ['9999999999999999', 'unknown'],
  ])('%s reads as %s', (digits, expected) => {
    expect(cardBrand(digits)).toBe(expected);
  });

  test('spacing and dashes in the submitted number do not reach last4 or the brand', async () => {
    const store = makeStore();
    const card = await store.create(cardInput({ number: '4111-1111 1111-1111' }));
    expect(card.last4).toBe('1111');
    expect(card.brand).toBe('visa');
    // The NORMALIZED digits are what is stored. `fillCard` types this value
    // verbatim into a card-number field, and separators there are a declined
    // order; the owner's spacing was data entry, not information.
    expect(secrets.values.get(cardSecretKey(card.id, 'number'))).toBe('4111111111111111');
  });

  test('the declared issuer cap and kind are carried through verbatim', async () => {
    const store = makeStore();
    const card = await store.create(cardInput({ kind: 'real', issuerCapMinorUnits: null }));
    expect(card.kind).toBe('real');
    expect(card.issuerCapMinorUnits).toBeNull();
  });

  test('a generated id is random, not derived from the number', () => {
    const ids = new Set(Array.from({ length: 32 }, () => newCardId()));
    expect(ids.size).toBe(32);
    for (const id of ids) expect(id).toMatch(/^card-[0-9a-f]{12}$/);
  });

  test('an injected id generator is honoured, so a caller can address what it wrote', async () => {
    const store = new DaemonCardStore({
      filePath,
      secrets,
      cvvHandling: () => 'stored',
      generateId: () => 'card-fixed',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    const card = await store.create(cardInput());
    expect(card.id).toBe('card-fixed');
    expect(card.addedAt).toBe('2026-01-02T03:04:05.000Z');
  });
});
