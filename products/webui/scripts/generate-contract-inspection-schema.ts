#!/usr/bin/env bun
/** Snapshot the public contract tree schema without shipping the full method catalog. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOperatorMethod } from '@goodvibes-jev/engine/contracts';

export const CONTRACT_SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/generated/contract-inspection-schema.json');
export function renderContractInspectionSchema(): string {
  const schema = getOperatorMethod('contracts.get')?.outputSchema;
  if (!schema) throw new Error('The engine does not expose the contract inspection schema.');
  return `${JSON.stringify(schema, null, 2)}\n`;
}
if (import.meta.main) {
  mkdirSync(dirname(CONTRACT_SCHEMA_PATH), { recursive: true });
  writeFileSync(CONTRACT_SCHEMA_PATH, renderContractInspectionSchema());
}
