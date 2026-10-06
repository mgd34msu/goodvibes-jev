import { isDirectOwnerCommandContext, type CommandRegistry } from '../command-registry.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { requireShellPaths } from './runtime-services.ts';

const USAGE = 'Usage: /host pair [--bootstrap-shared] [--name <device-name>] [--apply]. --yes and inline confirmation are unsupported; apply requires fresh confirmation in the owner terminal.';

/** Generic slash/tool dispatch is local, passive inspection only. The private
 * direct-owner route may begin the shell's cancellable pairing lifetime.
 */
export function registerHostPairingCommands(registry: CommandRegistry): void {
  registry.register({ name: 'host', description: 'Inspect or explicitly pair this TUI with its selected host in the owner terminal',
    async handler(args, context) {
      if (args[0] !== 'pair') { context.print(USAGE); return; }
      let apply = false; let bootstrapShared = false; let named = false; let name = 'GoodVibes TUI';
      for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply' && !apply) { apply = true; continue; }
        if (arg === '--bootstrap-shared' && !bootstrapShared) { bootstrapShared = true; continue; }
        if (arg === '--name' && !named && args[index + 1] && !args[index + 1]!.startsWith('--') && !/\s/.test(args[index + 1]!)) {
          named = true; name = args[++index]!; continue;
        }
        context.print(USAGE); return;
      }
      if (isDirectOwnerCommandContext(context, 'host') && context.beginHostPairing) {
        await context.beginHostPairing({ apply, bootstrapShared, name }); return;
      }
      if (apply) {
        context.print('Pairing --apply requires the owner to type /host pair --bootstrap-shared --apply in the live owner terminal. Model, harness and nested commands cannot grant persistent administrative access.');
        return;
      }
      try {
        const paths = requireShellPaths(context);
        const credential = resolveNativeHostCredential({ configManager: context.platform.configManager, homeDirectory: paths.homeDirectory });
        context.print(credential.available ? `TUI credential saved for ${credential.baseUrl}. Live scopes and native authority are checked by each operation.` : credential.reason);
        context.print('Local inspection only. For explicit pairing, type /host pair --bootstrap-shared in the live owner terminal, then add --apply to review and confirm. Existing /pair remains companion/WebUI pairing.');
      } catch { context.print('TUI host credentials are unavailable here. Use goodvibes host pair in an owner terminal.'); }
    },
  });
}
