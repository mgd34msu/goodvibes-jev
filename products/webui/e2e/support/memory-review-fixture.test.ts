import { expect, test } from "bun:test";
import { MEMORY_REVIEW_PROBABILITIES, rankFixtureMemoryReview } from "./memory-review-fixture";
import { MEMORY_FACT, SEED_MEMORY_RECORDS, memoryRecordWire } from "./seed";
import type { MemoryRecordWire } from "./mock-daemon";

const record = (id: string, confidence: number, updatedAt = 1, createdAt = 1): MemoryRecordWire =>
  memoryRecordWire({ ...MEMORY_FACT, id, confidence, updatedAt, createdAt });
const ids = (records: MemoryRecordWire[] | undefined) => records?.map((item) => item.id);

test("seed review queue retains every candidate, including high confidence and reviewed records", () => {
  const records = SEED_MEMORY_RECORDS.map(memoryRecordWire);
  expect(
    ids(rankFixtureMemoryReview(records, new Map(Object.entries(MEMORY_REVIEW_PROBABILITIES)), 10))
  ).toEqual(["mem-review-1", "mem-fact-1", "mem-persona-1"]);
  expect(records.map((item) => item.id)).toEqual(["mem-fact-1", "mem-review-1", "mem-persona-1"]);
});
test("explicit needs_review probability outranks confidence, review state and timestamps", () => {
  const highConfidence = { ...record("high-confidence", 100, 1), reviewState: "reviewed" as const };
  const lowConfidence = {
    ...record("low-confidence", 0, 999),
    reviewState: "contradicted" as const,
  };
  const zeroProbability = record("zero-probability", 1, 1_000);
  const probabilities = new Map([
    ["high-confidence", 1],
    ["low-confidence", 0.02],
    ["zero-probability", 0],
  ]);
  expect(
    ids(
      rankFixtureMemoryReview([lowConfidence, zeroProbability, highConfidence], probabilities, 10)
    )
  ).toEqual(["high-confidence", "low-confidence", "zero-probability"]);
  highConfidence.confidence = 0;
  lowConfidence.confidence = 100;
  expect(
    ids(
      rankFixtureMemoryReview([lowConfidence, zeroProbability, highConfidence], probabilities, 10)
    )
  ).toEqual(["high-confidence", "low-confidence", "zero-probability"]);
});
test("ties use updatedAt then createdAt and remain stable for completely equal readings", () => {
  const records = [
    record("older-updated", 1, 1, 999),
    record("older-created", 1, 2, 1),
    record("same-first", 99, 2, 2),
    record("same-second", 1, 2, 2),
  ];
  const probabilities = new Map(records.map((item) => [item.id, 0.75]));
  expect(ids(rankFixtureMemoryReview(records, probabilities, 10))).toEqual([
    "same-first",
    "same-second",
    "older-created",
    "older-updated",
  ]);
});
test.each([0, 1, 2, 100, -1])(
  "limit %s is applied after ranking and never changes candidates",
  (limit) => {
    const records = [record("low", 50), record("high", 50), record("middle", 50)];
    const probabilities = new Map([
      ["low", 0.1],
      ["high", 0.9],
      ["middle", 0.5],
    ]);
    expect(ids(rankFixtureMemoryReview(records, probabilities, limit))).toEqual(
      ["high", "middle", "low"].slice(0, Math.max(0, limit))
    );
    expect(records.map((item) => item.id)).toEqual(["low", "high", "middle"]);
  }
);
test.each([undefined, NaN, Infinity, -Infinity, -0.01, 1.01])(
  "missing or invalid probability %s fails the entire queue closed, even beyond the limit",
  (probability) => {
    const records = [record("known", 0), record("unread", 100)];
    const probabilities = new Map([["known", 1]]);
    if (probability !== undefined) probabilities.set("unread", probability);
    expect(rankFixtureMemoryReview(records, probabilities, 1)).toBeUndefined();
    expect(rankFixtureMemoryReview(records, probabilities, 0)).toBeUndefined();
  }
);
test("an empty queue needs no invented reading and unrelated map entries do not become candidates", () => {
  expect(rankFixtureMemoryReview([], new Map([["extra", 1]]), 10)).toEqual([]);
  const records = [record("actual", 1)];
  expect(
    ids(
      rankFixtureMemoryReview(
        records,
        new Map([
          ["extra", 1],
          ["actual", 0],
        ]),
        10
      )
    )
  ).toEqual(["actual"]);
});
