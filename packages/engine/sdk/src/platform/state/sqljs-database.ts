import { types as nodeTypes } from 'node:util';

const ownDescriptor = Object.getOwnPropertyDescriptor;
const MAX_ALLOCATION_ATTEMPTS = 3;

/** Allocation failures do not establish that a persisted database is corrupt. */
export class SqlJsDatabaseAllocationError extends Error {
  constructor(cause: unknown) {
    super('The private SQLite database could not be allocated.', { cause });
    this.name = 'SqlJsDatabaseAllocationError';
  }
}

/** sql.js uses random filenames in its private WASM filesystem. Supplying an
 * image, including an empty one, requires exclusive file creation instead of
 * silently opening another live database after a filename collision. */
export function createSqlJsDatabase<T>(Constructor: new (data?: Uint8Array) => T, data?: Uint8Array): T {
  const image = data ?? new Uint8Array();
  for (let attempt = 0; ; attempt++) {
    try { return new Constructor(image); }
    catch (error) {
      if (!error || typeof error !== 'object' || nodeTypes.isProxy(error)
        || ownDescriptor(error, 'name')?.value !== 'ErrnoError') throw error;
      // Emscripten EEXIST is 20. sql.js 1.14.2 minifies its errno field to Pa.
      const code: unknown = ownDescriptor(error, 'errno')?.value ?? ownDescriptor(error, 'Pa')?.value;
      if (code === 20 && attempt + 1 < MAX_ALLOCATION_ATTEMPTS) continue;
      throw new SqlJsDatabaseAllocationError(error);
    }
  }
}
