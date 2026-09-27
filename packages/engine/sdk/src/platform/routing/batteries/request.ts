/**
 * The request batteries: what a piece of work is, read before any model token
 * is spent on it. Six narrow batteries, each one question, asked together in
 * one request (readRequest fans them out) and composed in code by the tier
 * policy (policy.ts).
 *
 * State: `{ purpose, work }`. `purpose` names who will do the work (the
 * contract planner, a unit agent, an integration unit, a conversation turn);
 * `work` is the brief as written.
 *
 * Bands: the tier, difficulty and risk readings choose what the work costs
 * and how strong a model does it, so they take the medium bands; intent,
 * domain and language only inform the pick among candidates, so they take the
 * low bands. A wrong route is reversible: the work is still checked, and the
 * provider failover chain covers an outage.
 */
import { defineBattery, oneOf, rated, STAKES_BANDS } from '@goodvibes-jev/judgment';
import { WORK_TIER_OPTIONS } from '../tiers.js';

const LOW = STAKES_BANDS.low;
const MEDIUM = STAKES_BANDS.medium;

/** A fixture state: who does the work, and the brief. */
const work = (brief: string, purpose = 'unit'): { purpose: string; work: string } => ({ purpose, work: brief });

export const requestTier = defineBattery({
  name: 'routing.request-tier',
  version: 1,
  description: 'Which class of model a piece of work needs to be done well: economy, standard or premium.',
  accuracyFloor: 0.9,
  items: {
    tier: oneOf('Which class of language model does `work` need to be done well, given `purpose`?', WORK_TIER_OPTIONS, MEDIUM.confidence),
  },
  fixtures: [
    { name: 'rename a variable', state: work('Rename the variable `cnt` to `count` in src/utils/format.ts.'), expect: { tier: 'economy' } },
    { name: 'fix a typo', state: work('Fix the typo "recieve" in README.md.'), expect: { tier: 'economy' } },
    { name: 'greeting', state: work('Say good morning to the team in the standup channel.', 'conversation'), expect: { tier: 'economy' } },
    { name: 'add a json flag', state: work('Add a --json flag to the `status` CLI command that prints the same fields as JSON, and update its test.'), expect: { tier: 'standard' } },
    { name: 'write unit tests', state: work('Write unit tests for parseDuration covering hours, minutes, combined values and invalid input.'), expect: { tier: 'standard' } },
    { name: 'summarize a document', state: work('Summarize the attached quarterly report into five bullet points for the leadership email.'), expect: { tier: 'standard' } },
    {
      name: 'distributed lock race',
      state: work('Find why the distributed lock occasionally lets two workers hold the same lease during network partitions, and redesign it so every lease is fenced.'),
      expect: { tier: 'premium' },
    },
    {
      name: 'zero downtime migration design',
      state: work('Design the schema and the migration plan to split the monolithic orders table into sharded tables with zero downtime and no lost writes.'),
      expect: { tier: 'premium' },
    },
    {
      name: 'plan a contract',
      state: work('Break this request into units with acceptance criteria: move the billing service from polling to event-driven webhooks, keep every invoice exactly-once, and migrate the existing customers.', 'planner'),
      expect: { tier: 'premium' },
    },
  ],
});

export const INTENTS = {
  code_change: 'Write, change, fix or refactor code or configuration',
  code_review: 'Review existing code or a change and report problems',
  debugging: 'Find the cause of a failure, crash, wrong result or flaky behavior',
  planning: 'Plan, design or break down work before doing it',
  research: 'Find, gather and synthesize information from sources',
  writing: 'Write or edit prose: documents, messages, posts, explanations',
  analysis: 'Analyze data or information and reach conclusions',
  operations: 'Run commands, manage systems, deploy, or configure tools and services',
  conversation: 'Chat, answer a quick question, or acknowledge something',
} as const;

export type RequestIntent = keyof typeof INTENTS;

export const requestIntent = defineBattery({
  name: 'routing.request-intent',
  version: 1,
  description: 'What kind of work a request is: changing code, reviewing, debugging, planning, research, writing, analysis, operations or conversation.',
  accuracyFloor: 0.9,
  items: {
    intent: oneOf('What kind of work does `work` ask for?', INTENTS, LOW.confidence),
  },
  fixtures: [
    { name: 'implement an endpoint', state: work('Implement a PATCH /users/:id endpoint that updates the display name and email.'), expect: { intent: 'code_change' } },
    { name: 'review a pull request', state: work('Review the diff in PR 482 and list any correctness or security problems you find.'), expect: { intent: 'code_review' } },
    { name: 'flaky test cause', state: work('The checkout test fails about one run in ten with a timeout; find out why.'), expect: { intent: 'debugging' } },
    { name: 'plan a migration', state: work('Lay out the steps and order for moving our monorepo from Jest to Vitest without breaking CI.'), expect: { intent: 'planning' } },
    { name: 'compare vendors', state: work('Gather what is publicly documented about three hosted vector databases and compare their pricing and limits, citing sources.'), expect: { intent: 'research' } },
    { name: 'release announcement', state: work('Write the release announcement blog post for version 3.0, friendly tone, about 400 words.'), expect: { intent: 'writing' } },
    { name: 'churn numbers', state: work('Look at last quarter\'s churn numbers in churn.csv and tell me which customer segment drives the increase.'), expect: { intent: 'analysis' } },
    { name: 'rotate certificates', state: work('Restart the staging web servers and rotate their TLS certificates.'), expect: { intent: 'operations' } },
    { name: 'thanks', state: work('Thanks, that worked!', 'conversation'), expect: { intent: 'conversation' } },
  ],
});

export const requestDifficulty = defineBattery({
  name: 'routing.request-difficulty',
  version: 1,
  description: 'How hard a piece of work is for a skilled professional, on four levels.',
  accuracyFloor: 0.9,
  items: {
    difficulty: rated(
      'How hard is `work` for a skilled professional in its field?',
      [
        'Trivial: a single obvious step, seconds of thought.',
        'Routine: a familiar task with a few clear steps, minutes of work.',
        'Demanding: careful work across several interacting steps or some investigation, around an hour for a skilled professional.',
        'Hard: deep specialist reasoning that would take a senior expert many hours, such as distributed-systems correctness, security design, novel algorithms or proofs.',
      ],
      MEDIUM.confidence,
    ),
  },
  fixtures: [
    { name: 'fix a typo', state: work('Fix the typo "teh" in the page title.'), expect: { difficulty: 0 } },
    { name: 'bump a version', state: work('Change the version field in package.json from 1.4.1 to 1.4.2.'), expect: { difficulty: 0 } },
    { name: 'add a field', state: work('Add an optional `nickname` string field to the User type and show it on the profile page.'), expect: { difficulty: 1 } },
    { name: 'pagination', state: work('Add cursor pagination to the /orders list endpoint, keep the old offset parameters working, and cover both with tests.'), expect: { difficulty: 2 } },
    {
      name: 'consensus bug',
      state: work('Our Raft implementation elects two leaders in the same term after a partition heals; find the flaw in the vote handling and fix it with a proof sketch.'),
      expect: { difficulty: 3 },
    },
  ],
});

export const requestRisk = defineBattery({
  name: 'routing.request-risk',
  version: 1,
  description: 'How costly a wrong or careless result of a piece of work would be, on four levels.',
  accuracyFloor: 0.9,
  items: {
    risk: rated(
      'How costly would a wrong or careless result of `work` be?',
      [
        'Negligible: a mistake is obvious and redone in moments.',
        'Minor: a mistake wastes a little time or needs a small follow-up fix.',
        'Serious: a mistake breaks something that matters or wastes significant time, but can be recovered.',
        'Severe: a mistake could lose data, expose secrets or security holes, cost money, take production down, or cannot be undone.',
      ],
      MEDIUM.confidence,
    ),
  },
  fixtures: [
    { name: 'reword a comment', state: work('Reword the comment above parseArgs so it reads more clearly.'), expect: { risk: 0 } },
    { name: 'internal wiki paragraph', state: work('Add a paragraph to the internal team wiki describing how to request a new laptop.'), expect: { risk: 1 } },
    { name: 'refactor a shared module', state: work('Refactor the shared date utilities used by every service into smaller functions without changing behavior.'), expect: { risk: 2 } },
    {
      name: 'delete production records',
      state: work('Write and run the script that deletes duplicate customer records from the production billing database.'),
      expect: { risk: 3 },
    },
    {
      name: 'change auth checks',
      state: work('Change the session token validation in the auth middleware that guards every admin endpoint.'),
      expect: { risk: 3 },
    },
  ],
});

export const DOMAINS = {
  software: 'Software engineering: code, systems, tooling, infrastructure',
  data: 'Data work: datasets, queries, pipelines, statistics, machine learning',
  mathematics: 'Mathematics: proofs, calculation, formal reasoning',
  science: 'Natural or physical sciences',
  law: 'Law, contracts, compliance or regulation',
  medicine: 'Medicine or health',
  finance: 'Finance, accounting, investing or tax',
  business: 'Business operations, strategy, sales, marketing or management',
  creative: 'Creative writing, art, design or entertainment',
  personal: 'Personal life: email, calendar, errands, travel, household',
  general: 'General knowledge or anything not covered above',
} as const;

export type RequestDomain = keyof typeof DOMAINS;

export const requestDomain = defineBattery({
  name: 'routing.request-domain',
  version: 1,
  description: 'Which field a piece of work belongs to.',
  accuracyFloor: 0.9,
  items: {
    domain: oneOf('Which field does `work` belong to?', DOMAINS, LOW.confidence),
  },
  fixtures: [
    { name: 'fix a build', state: work('The TypeScript build fails with TS2322 in src/server.ts; fix it.'), expect: { domain: 'software' } },
    { name: 'sql cohort query', state: work('Write the SQL that computes weekly retention cohorts from the events table and chart the result.'), expect: { domain: 'data' } },
    { name: 'prove an identity', state: work('Prove that the sum of the first n odd numbers equals n squared.'), expect: { domain: 'mathematics' } },
    { name: 'photosynthesis', state: work('Explain how the light-dependent reactions of photosynthesis produce ATP.'), expect: { domain: 'science' } },
    { name: 'lease clause', state: work('Check whether the termination clause in this commercial lease lets the landlord end it early.'), expect: { domain: 'law' } },
    { name: 'drug interaction', state: work('Summarize the known interactions between warfarin and common antibiotics.'), expect: { domain: 'medicine' } },
    { name: 'depreciation', state: work('Compute straight-line depreciation for the new delivery vans and draft the journal entries.'), expect: { domain: 'finance' } },
    { name: 'pricing strategy', state: work('Draft a go-to-market plan and pricing tiers for our new team plan.'), expect: { domain: 'business' } },
    { name: 'short story', state: work('Write a short ghost story set in a lighthouse, under 800 words.'), expect: { domain: 'creative' } },
    { name: 'dentist appointment', state: work('Move my dentist appointment to next Thursday and email the office to confirm.'), expect: { domain: 'personal' } },
    { name: 'capital city', state: work('What is the capital of Australia?', 'conversation'), expect: { domain: 'general' } },
  ],
});

export const LANGUAGES = {
  english: 'English',
  chinese: 'Chinese',
  japanese: 'Japanese',
  korean: 'Korean',
  spanish: 'Spanish',
  french: 'French',
  german: 'German',
  portuguese: 'Portuguese',
  russian: 'Russian',
  other: 'Another language',
} as const;

export type RequestLanguage = keyof typeof LANGUAGES;

export const requestLanguage = defineBattery({
  name: 'routing.request-language',
  version: 1,
  description: 'Which natural language a request is written in.',
  accuracyFloor: 0.9,
  items: {
    language: oneOf('Which natural language is `work` written in? Ignore code, identifiers and quoted file names.', LANGUAGES, LOW.confidence),
  },
  fixtures: [
    { name: 'english', state: work('Add retry with backoff to the webhook sender.'), expect: { language: 'english' } },
    { name: 'chinese', state: work('请为登录接口添加速率限制，并编写相应的测试。'), expect: { language: 'chinese' } },
    { name: 'japanese', state: work('ログイン画面のボタンの色を青に変更してください。'), expect: { language: 'japanese' } },
    { name: 'korean', state: work('결제 모듈의 오류 메시지를 더 친절하게 바꿔 주세요.'), expect: { language: 'korean' } },
    { name: 'spanish', state: work('Corrige el error que impide guardar el formulario de contacto.'), expect: { language: 'spanish' } },
    { name: 'french', state: work('Ajoute une option pour exporter le rapport en PDF.'), expect: { language: 'french' } },
    { name: 'german', state: work('Schreibe Tests für die Funktion, die Rechnungsnummern erzeugt.'), expect: { language: 'german' } },
    { name: 'portuguese', state: work('Atualize a documentação da API com os novos parâmetros de busca.'), expect: { language: 'portuguese' } },
    { name: 'russian', state: work('Исправь ошибку, из-за которой приложение падает при запуске.'), expect: { language: 'russian' } },
    { name: 'dutch', state: work('Voeg een zoekveld toe aan de klantenlijst.'), expect: { language: 'other' } },
  ],
});

/** Every request battery, keyed as the fan-out names its parts. */
export const REQUEST_BATTERIES = {
  tier: requestTier,
  intent: requestIntent,
  difficulty: requestDifficulty,
  risk: requestRisk,
  domain: requestDomain,
  language: requestLanguage,
} as const;
