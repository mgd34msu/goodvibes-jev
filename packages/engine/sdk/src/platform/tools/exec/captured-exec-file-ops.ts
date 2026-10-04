import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { executeFileOperations } from './file-ops.js';
import type { ExecFileOp } from './schema.js';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Run the existing file-operation implementation only inside a disposable
 * projection. Authorization always receives logical captured paths, never the
 * temporary aliases. The caller owns initial projection and final apply-back
 * authorization; boundary failures here must discard the projection.
 */
export async function executeCapturedFileOperations(
  capturedRoot: string,
  projectionDirectory: string,
  fileOps: ExecFileOp[] | undefined,
  authorize: (path: string) => Promise<string>,
): ReturnType<typeof executeFileOperations> {
  if (!fileOps?.length) return { fileOpResults: [] };
  // Snapshot caller-owned operations before any asynchronous boundary.
  fileOps = structuredClone(fileOps);
  const root = resolve(capturedRoot);
  const projection = resolve(projectionDirectory);
  if (within(root, projection) || within(projection, root))
    throw new Error('captured file operations require a separate disposable projection');
  const initial = await lstat(projection);
  if (!initial.isDirectory() || initial.isSymbolicLink() || await realpath(projection) !== projection)
    throw new Error('captured file operation projection is redirected');

  const logicalPath = (path: string): string => {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || !within(root, absolute) || rel.split(sep).some((part) =>
      CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number])))
      throw new Error('file operation path is outside authorized captured input');
    return absolute;
  };
  const projectPath = (path: string): string => join(projection, relative(root, logicalPath(path)));
  const projected = fileOps.map((op) => ({
    ...op,
    source: projectPath(op.source),
    ...(op.destination !== undefined ? { destination: projectPath(op.destination) } : {}),
  }));
  const assertProjection = async (): Promise<void> => {
    const stat = await lstat(projection);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== initial.dev || stat.ino !== initial.ino ||
      await realpath(projection) !== projection)
      throw new Error('captured file operation projection changed');
  };
  const checked = new Set<string>();
  const trees = new Set<string>();
  const inspectPath = (path: string): Stats | undefined => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1))
        throw new Error('captured file operation contains an alias or special file');
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  };
  const recheckProjectionPaths = (): void => {
    const stat = lstatSync(projection);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== initial.dev || stat.ino !== initial.ino ||
      realpathSync(projection) !== projection)
      throw new Error('captured file operation projection changed');
    // A later authorization callback must not redirect an earlier checked
    // path. Recheck all physical paths without another permission await.
    for (const path of checked) inspectPath(path);
    for (const path of trees) if (inspectPath(path)?.isDirectory()) {
      for (const entry of readdirSync(path)) if (!checked.has(join(path, entry)))
        throw new Error('captured file operation tree changed during authorization');
    }
  };
  const checkPath = async (path: string): Promise<Stats | undefined> => {
    if (!within(projection, path) || path === projection)
      throw new Error('file operation escaped the captured projection');
    const rel = relative(projection, path);
    let current = '';
    let stat: Stats | undefined;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      const logical = logicalPath(join(root, current));
      if (await authorize(logical) !== logical)
        throw new Error('captured file operation authorization redirected a path');
      const physical = join(projection, current);
      checked.add(physical);
      stat = inspectPath(physical);
      if (current !== rel && stat && !stat.isDirectory())
        throw new Error('captured file operation parent is not a directory');
    }
    return stat;
  };
  const checkTree = async (path: string, destination?: string): Promise<void> => {
    trees.add(path);
    const stat = await checkPath(path);
    if (destination !== undefined) await checkPath(destination);
    if (!stat?.isDirectory()) return;
    for (const entry of await readdir(path))
      await checkTree(join(path, entry), destination === undefined ? undefined : join(destination, entry));
  };
  const result = await executeFileOperations(projected, projection, {
    beforeOperation: async (op) => {
      checked.clear();
      trees.clear();
      await assertProjection();
      await checkTree(op.source, op.op === 'delete' ? undefined : op.destination);
      if (op.op !== 'delete' && op.destination !== undefined) await checkTree(op.destination);
      await assertProjection();
      recheckProjectionPaths();
    },
    beforeImportUpdates: async () => {
      checked.clear();
      trees.clear();
      await assertProjection();
      trees.add(projection);
      // Import rewriting scans the project after all moves, including files
      // created by earlier operations. Validate that actual tree at scan time.
      for (const entry of await readdir(projection)) await checkTree(join(projection, entry));
      await assertProjection();
      recheckProjectionPaths();
    },
  });
  const restore = (value: string): string => value.replaceAll(projection, root);
  return {
    fileOpResults: result.fileOpResults.map((op) => ({
      ...op,
      source: restore(op.source),
      ...(op.destination !== undefined ? { destination: restore(op.destination) } : {}),
      ...(op.would_delete !== undefined ? { would_delete: op.would_delete.map(restore) } : {}),
      ...(op.updated_imports !== undefined ? { updated_imports: op.updated_imports.map(restore) } : {}),
      ...(op.warnings !== undefined ? { warnings: op.warnings.map(restore) } : {}),
    })),
    ...(result.fileOpError !== undefined ? { fileOpError: restore(result.fileOpError) } : {}),
    ...(result.fileOpWarnings !== undefined ? { fileOpWarnings: result.fileOpWarnings.map(restore) } : {}),
  };
}
