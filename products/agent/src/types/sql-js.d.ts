/**
 * Ambient typing for `sql.js`, which ships no types of its own.
 *
 * This file stays local rather than coming from the SDK: an ambient module
 * declaration only takes effect for a compilation that INCLUDES the file, and
 * the SDK's copy lives in its sources, not in its published package. A
 * declaration that never reaches this compilation is not a replacement for one
 * that does.
 */

declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
    exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: Uint8Array | Buffer) => Database;
  }

  function initSqlJs(): Promise<SqlJsStatic>;
  export default initSqlJs;
}
