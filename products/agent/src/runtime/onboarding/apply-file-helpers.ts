import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { writeStoreFile } from '@/utils/store-file.ts';

export type RollbackAction = () => Promise<void> | void;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`Expected an object JSON payload at ${path}.`);
  return parsed;
}

export function writeJsonObject(path: string, payload: Record<string, unknown>): void {
  writeStoreFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function setNestedValue(root: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.');
  const next = structuredClone(root);
  let cursor: Record<string, unknown> = next;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    let existing = cursor[part];
    if (!isPlainObject(existing)) {
      existing = {};
      cursor[part] = existing;
    }
    cursor = existing as Record<string, unknown>;
  }

  cursor[parts[parts.length - 1]!] = structuredClone(value);
  return next;
}

export function restoreFile(path: string, previous: string | null, reload?: () => void): void {
  if (previous === null) {
    if (existsSync(path)) unlinkSync(path);
  } else {
    writeStoreFile(path, previous);
  }
  reload?.();
}

export function snapshotFileRollback(path: string, reload?: () => void): RollbackAction {
  const previous = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  return () => restoreFile(path, previous, reload);
}

export async function runRollbacks(rollbacks: readonly RollbackAction[]): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const rollback of [...rollbacks].reverse()) {
    try {
      await rollback();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
