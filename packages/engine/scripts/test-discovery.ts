import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Runtime-specific suites have their own CI lanes. Fixtures and consumer
// type-test inputs are data, not behavioral test suites. Every other nested
// directory is discovered automatically, including future engine subsystems.
const SEPARATE_AREAS = new Set(['workers', 'workers-wrangler', 'hermes', 'fixtures', 'types']);
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** All ordinary engine tests, in stable order, relative to the engine root. */
export function defaultTestArgs(engineRoot: string): readonly string[] {
  const testRoot = resolve(engineRoot, 'test');
  const found: string[] = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || (relative === 'test' && SEPARATE_AREAS.has(entry.name))) continue;
        visit(join(directory, entry.name), `${relative}/${entry.name}`);
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        found.push(`${relative}/${entry.name}`);
      }
    }
  };
  visit(testRoot, 'test');
  return found.sort();
}
