import type { CommandRegistry } from '../command-registry.ts';
import { requireWebhookNotifier } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'notify',
    aliases: [],
    description: 'Manage and send configured Agent webhook notifications',
    usage: 'add <url> --yes | remove <url> --yes | list | clear --yes | test --yes | send <message> --yes',
    argsHint: 'list|add --yes|remove --yes|test --yes|send --yes',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const notifications = ctx.platform.configManager.getCategory('notifications');
      const urls: string[] = Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
      const notifier = requireWebhookNotifier(ctx);
      const sub = commandArgs[0];

      if (!sub || sub === 'list') {
        const showFull = commandArgs.includes('--show') && parsed.yes;
        if (urls.length === 0) ctx.print('No webhook URLs configured.\nUse /notify add <url>');
        else {
          const display = urls.map((u, i) => {
            if (showFull) return `  ${i + 1}. ${u}`;
            try {
              const parsedUrl = new URL(u);
              const origin = parsedUrl.origin;
              const truncPath = parsedUrl.pathname.length > 12
                ? `${parsedUrl.pathname.slice(0, 12)}…`
                : parsedUrl.pathname;
              return `  ${i + 1}. ${origin}${truncPath} (use /notify list --show --yes to reveal full URL)`;
            } catch {
              return `  ${i + 1}. (invalid URL)`;
            }
          });
          ctx.print(`Webhook URLs (${urls.length})\n${display.join('\n')}`);
        }
        return;
      }

      if (sub === 'add') {
        const url = commandArgs[1];
        if (!url) {
          ctx.print('Usage: /notify add <url> --yes\nExample: /notify add https://ntfy.sh/my-topic --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `add webhook notification URL ${url}`, '/notify add <url> --yes');
          return;
        }
        try { new URL(url); } catch {
          ctx.print(`Invalid URL ${url}`);
          return;
        }
        if (urls.includes(url)) {
          ctx.print(`Already configured ${url}`);
          return;
        }
        urls.push(url);
        ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: urls });
        notifier.setUrls(urls);
        ctx.print(`Webhook added: ${url}`);
        return;
      }

      if (sub === 'remove') {
        const url = commandArgs[1];
        if (!url) {
          ctx.print('Usage: /notify remove <url> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `remove webhook notification URL ${url}`, '/notify remove <url> --yes');
          return;
        }
        const next = urls.filter((u) => u !== url);
        if (next.length === urls.length) {
          ctx.print(`Not found: ${url}`);
          return;
        }
        ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: next });
        notifier.setUrls(next);
        ctx.print(`Webhook removed: ${url}`);
        return;
      }

      if (sub === 'clear') {
        if (!parsed.yes) {
          requireYesFlag(ctx, 'clear all webhook notification URLs', '/notify clear --yes');
          return;
        }
        ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: [] });
        notifier.setUrls([]);
        ctx.print('All webhook URLs cleared.');
        return;
      }

      if (sub === 'test') {
        if (!parsed.yes) {
          requireYesFlag(ctx, 'send webhook notification test requests', '/notify test --yes');
          return;
        }
        if (urls.length === 0) {
          ctx.print('No webhook URLs configured. Use /notify add <url>');
          return;
        }
        ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
        notifier.setUrls(urls);
        const results = await notifier.test();
        ctx.print(results.map((r) => r.ok ? `  [ok] ${r.url}` : `  [fail] ${r.url}, ${r.error ?? 'unknown error'}`).join('\n'));
        return;
      }

      if (sub === 'send') {
        const message = commandArgs.slice(1).join(' ').trim();
        if (!message) {
          ctx.print('Usage: /notify send <message> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, 'send a notification to configured webhook targets', '/notify send <message> --yes');
          return;
        }
        if (urls.length === 0) {
          ctx.print('No webhook URLs configured. Use /notify add <url>');
          return;
        }
        notifier.setUrls(urls);
        const result = await notifier.send(message);
        ctx.print([
          'Notification sent',
          `  attempted ${result.attempted}`,
          `  delivered ${result.delivered}`,
          `  failed ${result.failed}`,
          ...result.results.slice(0, 20).map((delivery, index) => (
            `  target ${index + 1} ${delivery.ok ? 'ok' : `failed${delivery.error ? ` (${delivery.error})` : ''}`}`
          )),
          ...(result.results.length > 20 ? [`  ${result.results.length - 20} more target(s) omitted.`] : []),
        ].join('\n'));
        return;
      }

      ctx.print('Usage: /notify add <url> --yes | remove <url> --yes | list | clear --yes | test --yes | send <message> --yes');
    },
  });
}
