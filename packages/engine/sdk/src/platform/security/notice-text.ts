/**
 * Neutralize untrusted notice text across all supported notification channels.
 * Channel adapters must also apply the escaping required by their wire format.
 */

/** Control characters and the Unicode line separators, which can forge a line. */
const CONTROL_OR_LINE_BREAK = new RegExp('[\\u0000-\\u001F\\u007F\\u2028\\u2029]', 'g');

/**
 * Markup metacharacters across every surface a notice can reach.
 *
 *  - backtick / asterisk / underscore / tilde / pipe, code, bold, italic,
 *    strikethrough and spoiler markers in Telegram MarkdownV2, Discord markdown
 *    and Slack mrkdwn.
 *  - angle brackets / square brackets / parentheses, link and mention syntax
 *    (`<http://x|text>` in Slack, `[text](url)` in Telegram and Discord).
 *    Parentheses are listed explicitly even though removing `[` already breaks
 *    the `[text](url)` pair: leaving that as the only thing stopping `(url)`
 *    from surviving is an implicit dependency between two character sets that a
 *    later edit to either could break silently.
 *  - ampersand, HTML entity forms on surfaces that render them.
 */
const MARKUP_TRIGGER_CHARS = /[`*_~|<>[\]&()]/g;

/**
 * The same set MINUS underscore, for fields where underscore is common and
 * legibility matters, an email local part, an owner's own product description.
 *
 * Underscore is the weakest trigger in the set: unpaired it renders literally,
 * and paired it is at worst cosmetic italics. It can never build a link or a
 * mention. Every other character here can, and is removed regardless of field.
 */
const LEGIBLE_MARKUP_TRIGGER_CHARS = /[`*~|<>[\]&()]/g;

const REPEATED_SPACE = / {2,}/g;

/**
 * Break `@everyone`, `@here`, `@channel` and `@role` mention forms.
 *
 * Discord and Slack turn a literal contiguous `@word` into a real mention when
 * the text is un-escaped. A zero-width space after every `@` that precedes a
 * word character breaks the contiguous match while staying invisible to a human
 * reader, `user@example.com` still reads as `user@example.com`.
 */
export function breakMentionForms(text: string): string {
  return text.replace(/@(?=\w)/g, '@​');
}

function sanitize(raw: string, maxLength: number, triggers: RegExp): string {
  // Order matters. Control characters and line breaks go FIRST, so that a later
  // step cannot reintroduce a forged line from a character a markup replacement
  // exposes. Then markup, then mention forms, then whitespace, then the cap.
  const noControlChars = raw.replace(CONTROL_OR_LINE_BREAK, ' ');
  const noMarkup = noControlChars.replace(triggers, ' ');
  const noMentionForms = breakMentionForms(noMarkup);
  const collapsed = noMentionForms.replace(REPEATED_SPACE, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * The sanitize every ATTACKER-CHOSEN free-text string passes through before it
 * can appear in a notice: a merchant's item title, seller or store name, a
 * shipping-option label, promotional text, a currency string, an email subject.
 *
 * Assume attacker-chosen unless the string demonstrably originated with the
 * owner. Provenance being partly verified is not an exemption, see the header.
 */
export function sanitizeNoticeField(raw: string, maxLength = 120): string {
  return sanitize(raw, maxLength, MARKUP_TRIGGER_CHARS);
}

/**
 * The sanitize for a field the OWNER authored, where underscore is worth
 * keeping for legibility.
 *
 * Still sanitized rather than trusted: threading provenance correctly is a thing
 * code gets wrong, and neutralising the owner's own text costs nothing but the
 * underscore exemption. A guarantee that holds only while every call site stays
 * correct is not a guarantee.
 */
export function sanitizeOwnerNoticeField(raw: string, maxLength = 120): string {
  return sanitize(raw, maxLength, LEGIBLE_MARKUP_TRIGGER_CHARS);
}

/** A hostname and nothing else: letters, digits and hyphens per label. */
const PLAIN_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * True when `host` is a bare hostname carrying no markup potential at all.
 *
 * Used as an assertion on a merchant identity that was supposedly computed by
 * `registrableDomain()` rather than read off a page. A computed value should
 * always pass; if one ever does not, the identity did not come from where the
 * caller believed, and rendering it would be exactly the defect this module is
 * about.
 */
export function isPlainHostname(host: string): boolean {
  return PLAIN_HOSTNAME.test(host);
}
