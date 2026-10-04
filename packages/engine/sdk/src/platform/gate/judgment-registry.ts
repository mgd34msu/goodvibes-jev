import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { riskFamily } from './batteries/risk-family.js';
import { sandboxAdvisory } from './batteries/sandbox-advisory.js';
import { sideEffect } from './batteries/side-effect.js';
import { boundaryReading } from './batteries/boundary.js';
import { sandboxNeeds } from './batteries/sandbox-needs.js';
import { settingsHazard } from './batteries/settings-hazard.js';
import { mcpScopeArg } from './batteries/mcp-scope-arg.js';
import { policyBreadth } from './batteries/policy-breadth.js';
import { ledgerArg } from './batteries/ledger-arg.js';
import { autonomousDisposition, autonomousRefusal } from './batteries/autonomous.js';

/**
 * Every named decision the gate makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/gate/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(riskFamily);
registry.register(sideEffect);
registry.register(sandboxAdvisory);
registry.register(boundaryReading);
registry.register(sandboxNeeds);
registry.register(settingsHazard);
registry.register(mcpScopeArg);
registry.register(policyBreadth);
registry.register(ledgerArg);
registry.register(autonomousDisposition);
registry.register(autonomousRefusal);

import { editTarget } from '../tools/batteries/edit-target.js';
import { contentRank } from '../tools/batteries/content-rank.js';
import { registryRank } from '../tools/batteries/registry-rank.js';

registry.register(editTarget);
registry.register(contentRank);
registry.register(registryRank);

import { semanticDiff } from '../tools/batteries/semantic-diff.js';
import { paramFill } from '../tools/batteries/param-fill.js';
import { execPrompt } from '../tools/batteries/exec-prompt.js';
import { execRetry } from '../tools/batteries/exec-retry.js';
import { childFailureReason } from '../tools/batteries/child-failure-reason.js';
import { credentialEnv } from '../tools/batteries/credential-env.js';

registry.register(semanticDiff);
registry.register(paramFill);
registry.register(execPrompt);
registry.register(execRetry);
registry.register(childFailureReason);
registry.register(credentialEnv);

import { secretFinding } from '../tools/batteries/secret-finding.js';
import { dangerousCall } from '../tools/batteries/dangerous-call.js';

registry.register(secretFinding);
registry.register(dangerousCall);

import { frontendFinding } from '../tools/batteries/frontend-finding.js';
import { projectTooling } from '../tools/batteries/project-tooling.js';

registry.register(frontendFinding);
registry.register(projectTooling);

import { exportBreak } from '../tools/batteries/export-break.js';
import { secretLine } from '../tools/batteries/secret-line.js';
import { dangerousLine } from '../tools/batteries/dangerous-line.js';
import { envTemplate } from '../tools/batteries/env-template.js';
import { testOfSource } from '../tools/batteries/test-of-source.js';
import { booleanValue } from '../tools/batteries/boolean-value.js';
import { memoryClass } from '../tools/batteries/memory-class.js';
import { ownerTerminal } from '../tools/batteries/owner-terminal.js';
import { pageContent } from '../tools/batteries/page-content.js';
import { pageSummary } from '../tools/batteries/page-summary.js';
import { credentialHeader } from '../tools/batteries/credential-header.js';
import { credentialValue } from '../tools/batteries/credential-value.js';
import { apiRoutes } from '../tools/batteries/api-routes.js';
import { outputKeep } from '../tools/batteries/output-keep.js';
import { healAcceptance } from '../tools/batteries/heal-acceptance.js';

registry.register(exportBreak);
registry.register(secretLine);
registry.register(dangerousLine);
registry.register(envTemplate);
registry.register(testOfSource);
registry.register(booleanValue);
registry.register(memoryClass);
registry.register(ownerTerminal);
registry.register(pageContent);
registry.register(pageSummary);
registry.register(credentialHeader);
registry.register(credentialValue);
registry.register(apiRoutes);
registry.register(outputKeep);
registry.register(healAcceptance);
