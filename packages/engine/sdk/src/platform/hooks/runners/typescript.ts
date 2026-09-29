import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync, statSync } from 'node:fs';
import type { HookDefinition, HookResult, HookEvent } from '../types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Expected shape of a TypeScript hook module's default export */
type TsHookHandler = (event: HookEvent) => Promise<HookResult> | HookResult;

/**
 * TypeScript hook runner.
 * Dynamically imports the module at hook.path and calls its default export with the event.
 */
export async function run(hook: HookDefinition, event: HookEvent, projectRoot: string): Promise<HookResult> {
  const path = hook.path;
  if (!path) {
    return { ok: false, error: 'ts hook missing "path" field' };
  }

  // The module must live inside the project directory. Compared on real paths,
  // so a symlink inside the project that points outside it is refused too.
  let resolvedPath: string;
  let realRoot: string;
  try {
    resolvedPath = realpathSync(resolve(projectRoot, path));
    realRoot = realpathSync(projectRoot);
  } catch {
    return { ok: false, error: `ts hook path '${path}' does not exist` };
  }
  const fromRoot = relative(realRoot, resolvedPath);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    return { ok: false, error: `ts hook path '${path}' is outside the project directory` };
  }

  try {
    let moduleUrl = pathToFileURL(resolvedPath).href;
    try {
      const { mtimeMs } = statSync(resolvedPath);
      moduleUrl += `?mtime=${mtimeMs}`;
    } catch {
      // Ignore stat failures and fall back to the bare file URL so import can surface the real error.
    }

    const mod = await import(moduleUrl);
    const handler = mod.default as TsHookHandler | undefined;

    if (typeof handler !== 'function') {
      return { ok: false, error: `ts hook at ${path} does not export a default function` };
    }

    const result = await handler(event);
    return result;
  } catch (err) {
    const message = summarizeError(err);
    logger.error('ts hook error', { path, error: message });
    return { ok: false, error: message };
  }
}
