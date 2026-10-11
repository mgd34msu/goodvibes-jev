/** Synthetic fixture answers only. No model, provider, account or mailbox writes. */
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';

const facts: Readonly<Record<string, string>> = {
  'Too many connections for this account, try again later': 'server',
  'Server busy, try again': 'server',
  'Invalid username or password': 'credential',
  'Mailbox does not exist': 'mailbox',
  'Unknown Mailbox: Alias-42': 'mailbox',
  'the cursor could not be written': 'write',
};
export function imapFixturePort() {
  return fakePort((name, question, state) => {
    const input = state as { message?: string; candidates?: { id: string; content: { name: string } }[] };
    if (input.message !== undefined) {
      // Strip only the session's prefix/tag/status grammar, then exact fixture equality.
      const text = input.message.replace(/^IMAP command failed: \S+ (?:NO|BAD) /, '');
      return noulAnswer(facts[text] === name ? 0.99 : 0.01);
    }
    const offered = input.candidates ?? [];
    const fixture = offered.find(candidate => ['DRAFTS', '[Gmail]/Drafts', 'Drafts', 'Brouillons'].includes(candidate.content.name));
    if (name === 'pick') return choiceAnswer(question, fixture?.id ?? 'none', 0.99);
    return noulAnswer(name === `fits_${offered.indexOf(fixture!)}` ? 0.99 : 0.01);
  });
}
