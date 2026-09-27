/**
 * `routing.task-route.pick`: which catalog route should handle a user task,
 * or none (the main conversation). One Choice over every catalog route id
 * plus none, and one yes/no fit question per route, asked in one request
 * (the select pattern). The fit readings also give the plan its
 * alternatives: every other route that reads as fitting, best first.
 *
 * This replaces the agent's keyword ladder: the hasAny/hasAll predicates
 * that decided whether a route applied, the hand-tuned integer scores that
 * ranked them, and the score-to-confidence cut-offs.
 *
 * Context: `{ request }`, the task as the user wrote it. Candidates: every
 * catalog route, content being the sentence that separates it from its
 * neighbours (catalog-*.ts).
 *
 * Bands: low stakes. Route planning is read-only and reversible; it never
 * runs a tool, and every effect a route leads to has its own confirmation.
 *
 * Fixtures: the agent's route tool test phrasings, and at least one request
 * per route in the catalog, plus plain conversation that needs no route.
 */
import { defineSelector, NONE, STAKES_BANDS, type Candidate } from '@goodvibes-jev/judgment';
import { TASK_ROUTES } from './catalog.js';

const LOW = STAKES_BANDS.low;

/** Every catalog route as the selector offers it. */
export function routeCandidates(): readonly Candidate[] {
  return TASK_ROUTES.map((entry) => ({ id: entry.id, content: entry.description }));
}

const CANDIDATES = routeCandidates();

const fixture = (request: string, expect: string, name = request) => ({ name, context: { request }, candidates: CANDIDATES, expect });

export const taskRoutePick = defineSelector({
  name: 'routing.task-route.pick',
  version: 2,
  description: 'Which catalog route should handle a user task, or none when the main conversation should answer it directly.',
  accuracyFloor: 0.9,
  instructions: 'An assistant has specialized routes (tools and workspaces) for kinds of user tasks. Each candidate describes the kind of task it serves. Which candidate route should handle `context.request`? Choose the route whose kind of task matches what the request is mainly about. Choose none when the request is ordinary conversation, a general knowledge question, or anything no candidate serves.',
  fitInstructions: 'Does this candidate route serve what `context.request` asks for, or a clear part of it?',
  band: LOW.confidence,
  fitBand: LOW.yesNo,
  fixtures: [
    // Setup, host and settings.
    fixture('run the first-run setup and repair the connected host token', 'setup-and-host-readiness'),
    fixture('install GoodVibes and finish onboarding', 'setup-and-host-readiness'),
    fixture('check daemon health', 'host-runtime-diagnostics'),
    fixture('is the connected host service compatible with this version?', 'host-runtime-diagnostics'),
    fixture('import my GoodVibes TUI settings', 'goodvibes-settings-import'),
    fixture('change the theme setting', 'agent-settings-configuration'),
    fixture('what is my default output format preference?', 'agent-settings-configuration'),
    // Models.
    fixture('check local model servers', 'local-model-smoke-check'),
    fixture('recommend an Ollama model for this laptop', 'local-model-cookbook-route'),
    fixture('set up ollama local model', 'local-model-cookbook-route'),
    fixture('connect OpenRouter subscription', 'model-provider-account-posture'),
    fixture('is my Anthropic API key still valid?', 'model-provider-account-posture'),
    fixture('choose the best model route for long context coding', 'model-route-readiness'),
    fixture('which models and providers are available to me right now?', 'model-provider-routing'),
    // Context and memory.
    fixture('make your personality more concise in VIBE.md', 'personality-and-context'),
    fixture('show the AGENTS.md project instructions you loaded', 'personality-and-context'),
    fixture('connect Supermemory as an external memory provider', 'external-memory-provider-posture'),
    fixture('set up cross-session memory sync', 'external-memory-provider-posture'),
    fixture('what do you remember about my coding preferences?', 'memory-learning'),
    fixture('forget what I told you about my old address', 'memory-learning'),
    // Personal Ops.
    fixture('set up the Gmail connector', 'personal-ops-connector-setup'),
    fixture('brief my calendar for today', 'personal-ops-daily-briefing'),
    fixture('show my saved inbox review queue', 'personal-ops-review-queue'),
    fixture('refresh my Gmail inbox', 'personal-ops-fresh-read-plan'),
    fixture('triage my inbox and draft replies', 'personal-ops-intake-route'),
    fixture('RSVP yes to the Friday team lunch invite', 'personal-ops-intake-route'),
    // Research and ongoing work.
    fixture('check browser-backed research runner readiness', 'research-browser-runner-readiness'),
    fixture('render the visual research report in the browser', 'research-visual-report-workflow'),
    fixture('do deep research on the market map and cite sources', 'deep-research-workflow'),
    fixture('research market risk with citations', 'deep-research-workflow'),
    fixture('remind me tomorrow to stretch', 'direct-schedule-route'),
    fixture('pause the nightly backup schedule', 'direct-schedule-route'),
    fixture('run a weekly source-backed research report', 'autonomy-intake'),
    fixture('run a weekly source-backed research report in background', 'autonomy-intake'),
    fixture('when a webhook fires for a new issue, triage it automatically', 'autonomy-intake'),
    // Execution.
    fixture('undo the last file edit', 'local-file-recovery'),
    fixture('run claude code with pty=true and handle sudo prompts', 'interactive-process-capability'),
    fixture('run pytest -v tests/ in background', 'local-background-process'),
    fixture('kill the background dev server process', 'local-background-process'),
    fixture('fix the failing tests in parallel', 'build-work'),
    fixture('Fix the failing tests in this repo.', 'build-work'),
    fixture('refactor the payment module and run the linter', 'build-work'),
    // Browser, desktop, media and voice.
    fixture('take a screenshot of the screen', 'browser-control-workflow-plan'),
    fixture('take a screenshot of the logged-in browser dashboard', 'browser-control-workflow-plan'),
    fixture('generate an image of a clean product dashboard', 'media-generation-artifact'),
    fixture('set up push-to-talk and voice memo transcription', 'voice-workflow-posture'),
    fixture('choose a TTS provider for spoken responses', 'tts-provider-posture'),
    fixture('open the browser dashboard', 'browser-cockpit-readiness'),
    fixture('log in to my account on example.com and download the invoice', 'drive-a-browser'),
    fixture('fill out the contact form on the website and submit it', 'drive-a-browser'),
    fixture('can you use my phone camera and microphone?', 'capability-map'),
    // Channels.
    fixture('set up Slack notifications', 'channels'),
    fixture('triage failed Discord delivery retries', 'channels'),
    fixture('show recent delivery receipts', 'channels'),
    fixture('send message to Telegram', 'channels'),
    // Documents, knowledge, security, support, sessions, release, host contract.
    fixture('compare models for this document', 'documents-artifacts-compare'),
    fixture('write process documentation', 'documents-artifacts-compare'),
    fixture('search knowledge for our deployment runbook', 'agent-knowledge'),
    fixture('show current permissions and approval mode', 'security-permission-status'),
    fixture('inspect the leaked secret security finding', 'security-finding-inspection'),
    fixture('why was that terminal command blocked', 'security-policy-explanation'),
    fixture('Why would settings action:set need confirmation?', 'security-policy-explanation'),
    fixture('export a support bundle for diagnostics', 'support-bundle-route'),
    fixture('search saved sessions for the onboarding thread', 'saved-session-route'),
    fixture('show release readiness inventory', 'release-audit'),
    fixture('inspect release evidence artifact live verification', 'release-audit'),
    fixture('list the daemon operator methods and api routes', 'connected-host-contract'),
    // No specialized route.
    fixture('what is the capital of France?', NONE),
    fixture('thanks, that helped a lot', NONE),
    fixture('explain the difference between a mutex and a semaphore', NONE),
  ],
});
