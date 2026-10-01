/**
 * mail-order, the one place the inbox's display order gets decided, extracted out
 * of MailView so the ordering rule is a pure, independently testable function rather
 * than something buried inside a `useMemo` callback.
 *
 * THE RULE, AND WHY IT IS NOT `date`: `uid` is assigned by the IMAP server when the
 * message is delivered to this account, so nothing the sender writes can change it.
 * `date` is the message's `Date:` header, which the SENDER puts there before the
 * message is ever sent to this account, attacker-chosen text, not a fact the
 * receiving server stamped. Sorting the inbox by `date` lets anyone emailing this
 * account choose where their message appears in the list, set a far-future date and
 * the message pins itself above everything real, indefinitely, which is exactly the
 * kind of control an attacker wants over what the operator sees first. Sort by `uid`
 * descending instead: newest-arrived first, using a value only this account's own
 * server gets to set.
 *
 * Do not "simplify" this back to `date`, it is the obvious-looking key for sorting
 * mail, which is exactly how this regresses if the reasoning above is not left here.
 */
export interface UidOrdered {
  readonly uid: number;
}

export function sortInboxMessagesByUidDescending<T extends UidOrdered>(
  messages: readonly T[],
): T[] {
  return [...messages].sort((a, b) => b.uid - a.uid);
}
