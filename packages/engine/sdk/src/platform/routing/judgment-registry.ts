import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Every named decision the routing subsystem makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/routing/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// Requests: what a piece of work needs, read before tokens are spent.
import { requestDifficulty, requestDomain, requestIntent, requestLanguage, requestRisk, requestTier } from './batteries/request.js';
registry.register(requestTier);
registry.register(requestIntent);
registry.register(requestDifficulty);
registry.register(requestRisk);
registry.register(requestDomain);
registry.register(requestLanguage);

// Models: tier, choice and identity across the whole catalog.
import { modelChoice, modelIdentity, modelTier } from './batteries/model.js';
registry.register(modelTier);
registry.register(modelChoice);
registry.register(modelIdentity);

// Catalog: how a provider's models are paid for.
import { catalogProviderAccess } from './batteries/catalog.js';
registry.register(catalogProviderAccess);

// Providers: local servers, alternate APIs, reasoning settings, stream labels, stop reasons.
import { alternateApi, contentPartKind, localServerIdentity, reasoningFamily, reasoningRejection, stopReason } from './batteries/provider.js';
registry.register(localServerIdentity);
registry.register(alternateApi);
registry.register(reasoningRejection);
registry.register(contentPartKind);
registry.register(stopReason);
registry.register(reasoningFamily);

// The user error line, hoisted from the TUI.
import { userErrorReading } from './user-error.js';
registry.register(userErrorReading);

// Task routes: the agent route planner and route tool, hoisted into the engine.
import { registry as taskRouteRegistry } from './task-routes/judgment-registry.js';
for (const decision of taskRouteRegistry.list()) registry.register(decision);

// Providers: model limits and listings.
import { anthropicOutputCap, chatModel, contextWindowFamily } from './batteries/model-limits.js';
registry.register(contextWindowFamily);
registry.register(anthropicOutputCap);
registry.register(chatModel);

// Providers: transports and prompt caching.
import { cacheMinimum, copilotClaudeModel } from './batteries/provider-cache.js';
registry.register(copilotClaudeModel);
registry.register(cacheMinimum);

// Provider setup presentation is separate from routing/catalog access semantics.
import { providerSetupReading } from '../providers/setup-reading.js';
registry.register(providerSetupReading);

// Agent model readiness and local hardware/recipe fit share one canonical definition.
import { localRecipeFit, routeReadiness } from './batteries/model-readiness.js';
registry.register(routeReadiness);
registry.register(localRecipeFit);
