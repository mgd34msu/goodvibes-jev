/**
 * Live proof of the routing subsystem.
 *
 * A real ProviderRegistry loads the live models.dev catalog (each provider's
 * access read by routing.catalog-provider-access) and cross-checks it with
 * the accounts configured on this machine; the route planner then routes a
 * handful of real requests through the request batteries, the model tier
 * readings and the model choice, and prints the tier each request needs, the
 * route it gets, its failover routes and the reason string the contract
 * runner records. Two user tasks also go through the hoisted task route
 * planner, and two provider errors through the hoisted user error line.
 *
 * Readings are remembered under $XDG_STATE_HOME/goodvibes-jev/routing-proof,
 * so a rerun asks only what is new.
 *
 *   TYPESAFE_API_KEY=... bun run --cwd packages/engine routing:proof
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ProviderRegistry } from '../sdk/src/platform/providers/registry.ts';
import { ProviderCapabilityRegistry } from '../sdk/src/platform/providers/capabilities.ts';
import { CacheHitTracker } from '../sdk/src/platform/providers/cache-strategy.ts';
import { FavoritesStore } from '../sdk/src/platform/providers/favorites.ts';
import { BenchmarkStore, compositeScore } from '../sdk/src/platform/providers/model-benchmarks.ts';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.ts';
import { createRoutePlanner, type RoutePlanRequest } from '../sdk/src/platform/routing/route-planner.ts';
import { planTaskRoute } from '../sdk/src/platform/routing/task-routes/planner.ts';
import { modelProviderNamedIds } from '../sdk/src/platform/routing/task-routes/named-ids.ts';
import { readUserFacingErrorLine } from '../sdk/src/platform/routing/user-error.ts';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

const stateDir = join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'goodvibes-jev', 'routing-proof');
mkdirSync(stateDir, { recursive: true });

installJudgmentPort(createSystemOnePort(judgmentConfigFromEnv(process.env)));

const benchmarkStore = new BenchmarkStore({ dir: stateDir });
const registry = new ProviderRegistry({
  // The registry reads only its persistence root and a few provider keys from
  // config; a proof has no config file, so every key reads as unset.
  configManager: {
    get: () => undefined,
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => stateDir,
  } as unknown as RegistryOptions['configManager'],
  subscriptionManager: {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as RegistryOptions['subscriptionManager'],
  secretsManager: {} as unknown as RegistryOptions['secretsManager'],
  serviceRegistry: {} as unknown as RegistryOptions['serviceRegistry'],
  capabilityRegistry: new ProviderCapabilityRegistry(),
  cacheHitTracker: new CacheHitTracker(),
  favoritesStore: new FavoritesStore({ dir: stateDir }),
  benchmarkStore,
  modelLimitsService: new ModelLimitsService({ cachePath: join(stateDir, 'model-limits.json') }),
});

console.log('Loading the live models.dev catalog and reading provider access...');
let started = Date.now();
await registry.refreshCatalog();
await benchmarkStore.refreshBenchmarks().catch((error: unknown) => {
  console.log(`  (benchmark leaderboard unavailable: ${error instanceof Error ? error.message : String(error)}; routing without benchmark facts)`);
});
const configured = registry.getConfiguredProviderIds();
console.log(`  ${registry.listModels().length} catalog models; configured providers: ${configured.join(', ')} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);

const planner = createRoutePlanner({
  catalog: registry,
  tiers: registry.modelTiers,
  benchmarkFor: (model) => {
    const entry = benchmarkStore.getKnownBenchmarks(model.displayName) ?? benchmarkStore.getKnownBenchmarks(model.id);
    return entry ? compositeScore(entry.benchmarks) : null;
  },
});

const REQUESTS: readonly RoutePlanRequest[] = [
  { purpose: 'unit', brief: 'Fix the typo "recieve" in README.md.' },
  { purpose: 'unit', brief: 'Add a --json flag to the status CLI command that prints the same fields as JSON, and update its test.' },
  { purpose: 'planner', brief: 'Break this request into units with acceptance criteria: move billing from polling to event-driven webhooks, keep every invoice exactly-once, and migrate existing customers.' },
  { purpose: 'unit', brief: 'Find why the distributed lock occasionally lets two workers hold the same lease during network partitions, and redesign it so every lease is fenced.' },
  { purpose: 'unit', brief: 'Schreibe Tests für die Funktion, die Rechnungsnummern erzeugt.' },
  { purpose: 'unit', brief: 'Look at the attached screenshot of the checkout page and list every layout bug you can see.', requires: { imageInput: true } },
];

let failures = 0;
for (const request of REQUESTS) {
  started = Date.now();
  try {
    const route = await planner.planRoute(request);
    console.log(`[${request.purpose}] ${request.brief}`);
    console.log(`  tier:      ${route.tier}${route.chosenTier === route.tier ? '' : ` (routed at ${route.chosenTier})`}`);
    console.log(`  route:     ${route.model}`);
    console.log(`  fallbacks: ${route.fallbackModels.length > 0 ? route.fallbackModels.join(', ') : '(none)'}`);
    console.log(`  reason:    ${route.reason}`);
    console.log(`  took ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  } catch (error) {
    failures += 1;
    console.log(`[${request.purpose}] ${request.brief}\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

console.log('Task routes (the hoisted agent route planner; model providers named from the live provider registry):');
const taskDeps = { namedIds: { modelProvider: () => modelProviderNamedIds(registry) } };
for (const query of ['take a screenshot of the screen', 'remind me tomorrow to stretch', 'is my ZenMux API key still working?']) {
  const plan = await planTaskRoute({ query }, taskDeps);
  if (plan.status !== 'ready') { failures += 1; continue; }
  console.log(`  "${query}" -> ${plan.preferred.id} (${plan.preferred.confidence}), confirmation ${plan.preferred.requiresConfirmation ? 'required' : 'not required'}; ${plan.preferred.modelRoute}`);
}
console.log('\nUser error lines (the hoisted TUI formatter):');
for (const error of [new Error('This model\'s maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.'), Object.assign(new Error('Your subscription session has ended. Sign in again.'), { status: 401 })]) {
  console.log(`  ${await readUserFacingErrorLine(error, 'routing.proof.user-error')}`);
}

process.exit(failures === 0 ? 0 : 1);
