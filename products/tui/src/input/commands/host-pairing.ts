import type { CommandRegistry } from '../command-registry.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { requireShellPaths } from './runtime-services.ts';

/** Generic slash/tool dispatch has no owner confirmation capability. This route
 * is local, passive guidance only; pairing lives in the standalone terminal.
 */
export function registerHostPairingCommands(registry: CommandRegistry): void {
  registry.register({ name: 'host', description: 'Inspect local host credential availability; pair explicitly from goodvibes host pair in an owner terminal',
    handler: (args, context) => {
      if (args.length !== 1 || args[0] !== 'pair') {
        context.print('Usage: /host pair. This surface cannot apply pairing; use goodvibes host pair --bootstrap-shared --apply in an owner terminal.');
        return;
      }
      try {
        const paths = requireShellPaths(context);
        const credential = resolveNativeHostCredential({ configManager: context.platform.configManager, homeDirectory: paths.homeDirectory });
        context.print(credential.available ? `TUI credential saved for ${credential.baseUrl}. Live scopes and native authority are checked by each operation.` : credential.reason);
        context.print('Local inspection only. For explicit pairing, exit to an owner terminal and run goodvibes host pair --bootstrap-shared, then add --apply after reviewing it. Existing /pair remains companion/WebUI pairing.');
      } catch { context.print('TUI host credentials are unavailable here. Use goodvibes host pair in an owner terminal.'); }
    },
  });
}
