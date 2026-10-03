/**
 * settings-search-vocabulary.ts, the plain words a person uses for a settings
 * domain, and the guided flow that domain has when settings alone cannot finish
 * the job.
 *
 * A settings search reads the key and the description, and both are written in
 * the platform's vocabulary. `payments.budget.dailyItem` describes itself as
 * "Most that may be spent on ITEM PRICES in one calendar day, written the way
 * you would say it", accurate, and it contains neither "spending limit" nor
 * "credit card", which is what was actually asked. The catalog answered "0",
 * the model reported that the platform has no payment settings, and
 * thirty-two live keys went unmentioned.
 *
 * So each domain carries the words for it as well as its own. These are search
 * aliases only: they are indexed beside the key and never displayed as if the
 * schema said them, and nothing here can add, hide, or rename a setting.
 *
 * Every domain named here must exist in CONFIG_SCHEMA, a test pins that, so an
 * alias for a domain that was renamed or removed fails the build instead of
 * quietly indexing nothing.
 */

export interface SettingDomainVocabulary {
  /** Plain-language words and phrases that should reach this domain. */
  readonly aliases: readonly string[];
  /**
   * A guided flow that does what settings cannot. Named in the search result so
   * a caller who found the budgets also learns how the card is entered.
   */
  readonly relatedCommand?: { readonly command: string; readonly why: string };
}

export const SETTING_DOMAIN_VOCABULARY: Readonly<Record<string, SettingDomainVocabulary>> = {
  payments: {
    aliases: [
      'payment', 'payments', 'pay', 'paying', 'card', 'credit card', 'debit card', 'card on file',
      'money', 'spend', 'spending', 'spending limit', 'spend limit', 'budget', 'daily budget',
      'purchase', 'purchasing', 'buy', 'buying', 'order', 'checkout', 'cart', 'commerce',
      'billing', 'billing address', 'shipping', 'shipping address', 'delivery', 'retailer',
      'price', 'cost', 'charge', 'refund', 'cvv', 'expiry', 'approval window', 'veto window',
    ],
    relatedCommand: {
      command: '/payments card',
      why: 'The card number, expiry and verification code are never settings, they are typed at a local terminal through a masked prompt. /payments address billing|shipping enters the two addresses; /payments status shows what is set.',
    },
  },
  occasions: {
    aliases: ['birthday', 'birthdays', 'anniversary', 'occasion', 'occasions', 'reminder', 'important date', 'gift'],
  },
  voice: {
    aliases: ['voice', 'speech', 'wake word', 'talk', 'speak', 'microphone', 'listening', 'push to talk'],
  },
  surfaces: {
    aliases: ['telegram', 'discord', 'slack', 'signal', 'whatsapp', 'ntfy', 'email', 'channel', 'messaging', 'notify me'],
  },
  provider: {
    aliases: ['model', 'llm', 'api key', 'anthropic', 'openai', 'reasoning effort', 'which model'],
  },
  permissions: {
    aliases: ['permission', 'approval', 'ask me first', 'auto approve', 'allowed tools', 'confirmation'],
  },
  sandbox: {
    aliases: ['sandbox', 'isolation', 'shell safety', 'command safety', 'exec guard'],
  },
  memory: {
    aliases: ['memory', 'remember', 'recall', 'context window', 'compaction'],
  },
  profile: {
    aliases: ['about me', 'owner profile', 'my details', 'personal details', 'who i am'],
  },
  display: {
    aliases: ['theme', 'dark mode', 'light mode', 'appearance', 'colours', 'colors', 'look'],
  },
  update: {
    aliases: ['update', 'upgrade', 'new version', 'auto update', 'release channel'],
  },
};

/** The alias text indexed beside a setting key, or '' for a domain with none. */
export function settingDomainAliasText(key: string): string {
  const domain = key.split('.')[0] ?? '';
  const vocabulary = SETTING_DOMAIN_VOCABULARY[domain];
  return vocabulary ? vocabulary.aliases.join('\n') : '';
}

/** The guided flow for a key's domain, when it has one. */
export function settingDomainRelatedCommand(key: string): SettingDomainVocabulary['relatedCommand'] {
  const domain = key.split('.')[0] ?? '';
  return SETTING_DOMAIN_VOCABULARY[domain]?.relatedCommand;
}
