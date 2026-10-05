#!/usr/bin/env bun
/** Check snapshots against public engine data without rewriting the working tree. */
import { readFileSync } from 'node:fs';
import { loadSchemaSnapshot, renderTs as renderSchema, TS_OUT_PATH as schemaPath } from './generate-config-schema';
import { loadOwnershipSnapshot, renderTs as renderOwnership, TS_OUT_PATH as ownershipPath } from './generate-config-ownership';
import { loadContractSnapshot, renderTs as renderPresentation, renderCss, TS_OUT_PATH as presentationPath, CSS_OUT_PATH } from './generate-presentation-tokens';

import { CONTRACT_SCHEMA_PATH, renderContractInspectionSchema } from './generate-contract-inspection-schema';

const presentation = loadContractSnapshot();
const artifacts = [
  [CONTRACT_SCHEMA_PATH, renderContractInspectionSchema()],
  [schemaPath, renderSchema(await loadSchemaSnapshot())],
  [ownershipPath, renderOwnership(loadOwnershipSnapshot())],
  [presentationPath, renderPresentation(presentation)],
  [CSS_OUT_PATH, renderCss(presentation)],
] as const;
const stale = artifacts.filter(([path, expected]) => readFileSync(path, 'utf8') !== expected);
if (stale.length) {
  for (const [path] of stale) console.error(`Stale engine snapshot: ${path}`);
  console.error('Run bun run release:prepare from products/webui and review the generated changes.');
  process.exit(1);
}
console.log('WebUI configuration, ownership, presentation and contract inspection snapshots match the workspace engine.');
