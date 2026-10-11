/** Shared non-executing workflow gate, including reusable callers and .yaml files. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function workflowStructureProblems(text: string): string[] {
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); }
  catch (error) { return [`does not parse as YAML: ${String(error)}`]; }
  if (!object(doc)) return ['top-level document is not a mapping'];
  const errors: string[] = [];
  if (typeof doc.name !== 'string' || !doc.name.trim()) errors.push('missing non-empty name');
  if (!('on' in doc)) errors.push('missing on trigger block');
  if (!object(doc.jobs) || !Object.keys(doc.jobs).length) return [...errors, 'missing non-empty jobs map'];
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (!object(job)) { errors.push(`${name}: job is not a mapping`); continue; }
    if (typeof job.uses !== 'string' || !job.uses.trim()) {
      if (!('runs-on' in job)) errors.push(`${name}: missing runs-on`);
      if (!Array.isArray(job.steps) || !job.steps.length) errors.push(`${name}: no steps`);
    }
    // An expression may evaluate true too; only explicit false is safe.
    if ('continue-on-error' in job && job['continue-on-error'] !== false) {
      errors.push(`${name}: job-level continue-on-error can hide failure`);
    }
  }
  return errors;
}

export function checkWorkflowDirectory(directory: string): string[] {
  const files = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file)).sort();
  if (!files.length) return ['no workflow files found'];
  return files.flatMap((file) => workflowStructureProblems(readFileSync(join(directory, file), 'utf8'))
    .map((problem) => `${file}: ${problem}`));
}
