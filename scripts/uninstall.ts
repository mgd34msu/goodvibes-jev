import { resolve } from 'node:path';
import { uninstall } from './installation.ts';

if (import.meta.main) {
  try {
    let prefix = resolve(process.env.HOME ?? '', '.local/share/goodvibes-jev');
    let purge = false;
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--prefix' && args[i + 1]) prefix = resolve(args[++i]!);
      else if (args[i] === '--purge') purge = true;
      else if (args[i] === '--help' || args[i] === '-h') {
        console.log('Usage: goodvibes-uninstall [--purge]\nUser data is preserved unless --purge is given.'); process.exit(0);
      } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    await uninstall(prefix, purge);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
