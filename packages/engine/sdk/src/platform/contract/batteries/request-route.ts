/**
 * `contract.request-route` (docs/design/contract-runner.md 10.3): whether a
 * person's turn is conversation, a question answered by reading, or work
 * that produces or changes something and so runs as a contract. It replaces
 * the keyword routing nudge the review loop injected into the model's prompt;
 * nothing is injected now, and the turn loop acts on the route.
 *
 * Read once per user turn, over `{ request }`, the turn's text verbatim.
 *
 * Bands: a wrong `contract` starts agents and changes files, so that route
 * reads at the high band; the other two leave the turn to the conversation
 * model, which may still start a contract through the agent tool, so they read
 * at medium. Below act on any route the turn goes on as a normal turn.
 */
import { defineDispatch, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const REQUEST_ROUTE_SITE = 'contract.request-route';

export const requestRoute = defineDispatch({
  name: REQUEST_ROUTE_SITE,
  version: 1,
  description: 'Whether a person\'s message is conversation, a question answered by reading, or work that produces or changes something and runs as a contract.',
  accuracyFloor: 0.9,
  instructions: 'What does the person ask for in `request`? Judge the whole message: what they want done, not the words it uses.',
  routes: {
    converse: 'Conversation, a question about the conversation, or a request needing no work on files or systems',
    answer: 'A question answered from knowledge or by reading, with no change to anything',
    contract: 'Work that produces or changes something: code, files, documents, configuration, or a multi-step task',
  },
  band: { ...STAKES_BANDS.medium.confidence, perOption: { contract: STAKES_BANDS.high.confidence } },
  fixtures: [
    { name: 'greeting', state: { request: 'hey, good morning!' }, expect: 'converse' },
    { name: 'thanks', state: { request: 'thanks, that makes sense now' }, expect: 'converse' },
    { name: 'about the conversation', state: { request: 'what did you say about the retry logic a minute ago?' }, expect: 'converse' },
    { name: 'opinion without work', state: { request: 'do you think tabs or spaces are better for this team?' }, expect: 'converse' },
    { name: 'knowledge question', state: { request: 'What is the difference between a mutex and a semaphore?' }, expect: 'answer' },
    { name: 'read the code to explain', state: { request: 'How does the session store decide when to write to disk? Look at the code and explain it.' }, expect: 'answer' },
    { name: 'find where', state: { request: 'where is the rate limiter configured in this repo?' }, expect: 'answer' },
    { name: 'review only, no changes', state: { request: 'Read src/billing/invoice.ts and tell me whether the rounding looks right. Do not change anything.' }, expect: 'answer' },
    { name: 'implement a feature', state: { request: 'Add a --json flag to the export command that prints the report as JSON.' }, expect: 'contract' },
    { name: 'fix a failing test', state: { request: 'The date parser test is failing on leap years, fix it.' }, expect: 'contract' },
    { name: 'write a document', state: { request: 'Write a migration guide in docs/ for moving from v1 to v2 of the config file.' }, expect: 'contract' },
    { name: 'multi-step task', state: { request: 'Rename the user service to account service everywhere, update the imports, and make sure the build still passes.' }, expect: 'contract' },
    { name: 'change configuration', state: { request: 'Turn on strict null checks in tsconfig and fix whatever breaks.' }, expect: 'contract' },
    { name: 'question phrased around work', state: { request: 'Can you make the login page remember the last email address used?' }, expect: 'contract' },
  ],
});
