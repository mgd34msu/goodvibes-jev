/**
 * agent-harness-operator-method-vocabulary.ts, the plain words a person uses
 * for a family of operator methods.
 *
 * The operator catalog is written in the platform's own vocabulary. The five
 * calendar methods describe themselves as reading "the configured CalDAV
 * calendar", accurate, and the word CalDAV is nowhere in anyone's question.
 * Asked `host action:"methods" query:"google"`, the catalog answered
 * `{ methods: [], returned: 0, total: 434 }` over and over, and the only way
 * forward was to guess method ids from memory. The calendar the daemon reads
 * on this platform IS a Google calendar (the daemon composition supplies
 * platform/google/gateway-calendar-service.ts behind those five ids) and the
 * mailbox behind `email.*` is reached with Gmail credentials, so the catalog
 * knew the answer and had no word in it that the question used.
 *
 * So each method CATEGORY carries the words for it as well as its own. These
 * are search aliases only: they are indexed beside the method's id, title,
 * description and category, and never displayed as if the contract had said
 * them. Nothing here can add, hide, rename or make callable a method.
 *
 * Every category named here must exist in the live operator contract, a test
 * pins that, so an alias for a category that was renamed or removed fails the
 * build instead of quietly indexing nothing.
 */

/** Plain-language words and phrases that should reach a method category. */
export const OPERATOR_METHOD_CATEGORY_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  calendar: [
    // The daemon's calendar connector is Google-backed; CalDAV is the protocol
    // it speaks, not the service a person names.
    'google', 'google calendar', 'gcal', 'gmail account', 'caldav', 'ical', 'icalendar', 'ics',
    'appointment', 'appointments', 'meeting', 'meetings', 'schedule', 'event', 'events', 'agenda',
    'diary', 'availability', 'free busy', 'invite', 'invitation',
  ],
  email: [
    // Same reason: the inbound mail reader authenticates to Gmail when Google
    // credentials have been adopted, and reads the mailbox over IMAP otherwise.
    // (Named without quoting the config key: this file consumes no settings,
    // and the settings denominator counts a quoted key literal as a consumer.)
    'google', 'gmail', 'google mail', 'mail', 'email', 'e-mail', 'inbox', 'message', 'messages',
    'imap', 'smtp', 'draft', 'drafts', 'send mail', 'read mail', 'mailbox',
  ],
  accounts: [
    // Where a connected Google account's posture is actually reported.
    'google', 'google account', 'account', 'accounts', 'connected account', 'sign in', 'signed in',
    'login', 'logged in', 'oauth', 'credential', 'credentials', 'connection', 'connected',
    'provider account', 'api key', 'token', 'refresh token',
  ],
  providers: [
    'google', 'provider', 'providers', 'model', 'models', 'llm', 'anthropic', 'openai',
    'api key', 'which model', 'reasoning effort', 'usage', 'pricing',
  ],
  profile: [
    // The owner profile's sections and mechanical fields are free-form, so
    // "which account is mine, which address is mine" is recorded there and
    // nowhere else, the questions a connect-an-account flow ends up asking,
    // and the ones a caller reaching for "google" was in the middle of.
    'google', 'about me', 'owner profile', 'my details', 'personal details', 'who i am',
    'my address', 'my email', 'shipping address', 'billing address', 'person', 'people',
    'preference', 'preferences', 'provenance',
  ],
  auth: [
    'login', 'log in', 'sign in', 'password', 'user', 'users', 'session', 'sessions',
    'revoke', 'rotate', 'credential', 'credentials', 'bootstrap',
  ],
  channels: [
    'telegram', 'discord', 'slack', 'signal', 'whatsapp', 'ntfy', 'sms', 'chat',
    'channel', 'channels', 'messaging', 'notify me', 'notification', 'route', 'routing',
  ],
  payments: [
    'payment', 'payments', 'pay', 'card', 'credit card', 'debit card', 'money', 'spend',
    'spending', 'spending limit', 'budget', 'purchase', 'buy', 'order', 'checkout', 'billing',
  ],
  occasions: [
    'birthday', 'birthdays', 'anniversary', 'occasion', 'occasions', 'reminder',
    'important date', 'gift',
  ],
  voice: [
    'voice', 'speech', 'wake word', 'talk', 'speak', 'microphone', 'listening', 'push to talk',
    'text to speech', 'speech to text', 'transcribe',
  ],
  memory: ['memory', 'remember', 'recall', 'forget', 'knowledge', 'note', 'notes'],
  knowledge: ['knowledge', 'document', 'documents', 'file', 'files', 'search', 'index', 'ingest'],
  browser: ['browser', 'web', 'website', 'page', 'click', 'screenshot', 'navigate', 'scrape'],
  sessions: ['session', 'sessions', 'conversation', 'chat history', 'transcript', 'rewind'],
  automation: ['automation', 'job', 'jobs', 'schedule', 'scheduled', 'cron', 'trigger', 'run', 'runs'],
  services: ['service', 'services', 'daemon', 'install', 'restart', 'start', 'stop', 'uninstall', 'systemd'],
  settings: ['setting', 'settings', 'config', 'configuration', 'option', 'options', 'preference'],
  health: ['health', 'status', 'diagnostics', 'posture', 'alive', 'up', 'down'],
  media: ['media', 'image', 'picture', 'photo', 'audio', 'video', 'generate image'],
  remote: ['remote', 'ssh', 'cloud', 'machine', 'host', 'node'],
  skills: ['skill', 'skills', 'plugin', 'plugins', 'capability'],
  telemetry: ['telemetry', 'metric', 'metrics', 'cost', 'usage', 'tokens', 'analytics'],
  watchers: ['watcher', 'watchers', 'watch', 'poll', 'monitor'],
  approvals: ['approval', 'approvals', 'approve', 'deny', 'permission', 'ask me first', 'confirm'],
};

/**
 * The alias text indexed beside a method, or '' for a category with none.
 */
export function operatorMethodCategoryAliasText(category: string): string {
  const aliases = OPERATOR_METHOD_CATEGORY_VOCABULARY[category];
  return aliases ? aliases.join('\n') : '';
}
