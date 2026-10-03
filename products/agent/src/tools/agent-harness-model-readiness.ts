import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readProviderHealthSignal } from './agent-harness-model-provider-health.ts';
import { localStackFor } from './agent-harness-local-model-endpoints.ts';
import type { LocalModelBenchmarkEvidence, LocalModelBenchmarkRouteLatency, LocalModelDetection, LocalModelHardwareProfile, LocalModelRecipe, LocalModelRecipeFit, ModelCandidate, ModelReadinessDimension, ModelReadinessScore, ModelRouteReadinessScore, ModelProviderHealthSignal } from './agent-harness-model-routing-types.ts';
import { readRecord } from './agent-harness-model-routing-utils.ts';

export function localRecipeStackId(recipe: LocalModelRecipe): string {
  return recipe.id === 'openai-compatible-local' ? 'openai-compatible' : recipe.id === 'llama-cpp' ? 'llama.cpp' : recipe.id;
}

export function roundGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(0, Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10);
}

export function localHardwareProfile(): LocalModelHardwareProfile {
  const cpuList = cpus();
  const ramGb = roundGb(totalmem());
  const freeRamGb = roundGb(freemem());
  const runtimePlatform = platform();
  const runtimeArch = arch();
  const acceleratorHint = runtimePlatform === 'darwin' && runtimeArch === 'arm64'
    ? 'apple-silicon'
    : (process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES)
      ? 'cuda-env'
      : 'none-detected';
  return {
    platform: runtimePlatform,
    arch: runtimeArch,
    cpuModel: previewHarnessText(cpuList[0]?.model ?? 'unknown CPU', 96),
    cpuThreads: cpuList.length,
    ramGb,
    freeRamGb,
    memoryTier: ramGb >= 64 ? 'large' : ramGb >= 32 ? 'comfortable' : ramGb >= 16 ? 'starter' : 'constrained',
    acceleratorHint,
    privacy: 'local-only',
    caveat: 'Hardware scan uses local OS memory/CPU data and safe accelerator hints only; it does not probe drivers, download models, or benchmark live inference.',
  };
}

export function fitLevel(score: number): LocalModelRecipeFit['level'] {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'good';
  if (score >= 50) return 'usable';
  return 'weak';
}

export function clampFit(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function modelReadinessLevel(score: number): ModelReadinessScore['level'] {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'usable';
  return 'risky';
}

export function capabilityEnabled(capabilities: unknown, key: 'toolCalling' | 'multimodal'): boolean | null {
  const value = readRecord(capabilities)[key];
  if (typeof value === 'boolean') return value;
  return null;
}

export function isLocalCandidate(fields: readonly string[]): boolean {
  return fields.some((field) => Boolean(localStackFor(field)));
}

export function contextWindowScore(contextWindow: number | null): ModelReadinessDimension {
  const score = contextWindow == null
    ? 45
    : contextWindow >= 128_000
      ? 100
      : contextWindow >= 64_000
        ? 88
        : contextWindow >= 32_000
          ? 76
          : contextWindow >= 16_000
            ? 62
            : 45;
  return {
    id: 'context-window',
    label: 'Context window',
    score,
    weight: 20,
    summary: contextWindow == null
      ? 'No context-window metadata; inspect the provider route before long-context work.'
      : `${contextWindow.toLocaleString()} token context window.`,
  };
}

export function toolSupportScore(capabilities: unknown): ModelReadinessDimension {
  const enabled = capabilityEnabled(capabilities, 'toolCalling');
  return {
    id: 'tool-support',
    label: 'Tool support',
    score: enabled === true ? 100 : enabled === false ? 35 : 55,
    weight: 20,
    summary: enabled === true
      ? 'Tool calling is advertised.'
      : enabled === false
        ? 'Tool calling is not advertised; use for chat or drafting, not autonomous tool workflows.'
        : 'Tool-calling support is unknown; inspect the provider before tool-heavy work.',
  };
}

export function visionScore(capabilities: unknown): ModelReadinessDimension {
  const enabled = capabilityEnabled(capabilities, 'multimodal');
  return {
    id: 'vision',
    label: 'Vision',
    score: enabled === true ? 100 : enabled === false ? 45 : 55,
    weight: 10,
    summary: enabled === true
      ? 'Vision or multimodal input is advertised.'
      : enabled === false
        ? 'Vision is not advertised; avoid image/screen-heavy work on this route.'
        : 'Vision support is unknown.',
  };
}

export function costScore(tier: string | undefined, local: boolean): ModelReadinessDimension {
  const normalized = (tier ?? '').toLowerCase();
  const score = local
    ? 100
    : normalized === 'free'
      ? 95
      : normalized === 'subscription'
        ? 86
        : normalized === 'standard'
          ? 72
          : normalized === 'premium'
            ? 55
            : 62;
  return {
    id: 'cost',
    label: 'Cost',
    score,
    weight: 15,
    summary: local
      ? 'Local route; marginal token cost is user hardware and power.'
      : tier
        ? `${tier} tier route.`
        : 'Cost tier is unknown; inspect provider pricing before long runs.',
  };
}

export function privacyScore(local: boolean, providerId: string): ModelReadinessDimension {
  const normalized = providerId.toLowerCase();
  const score = local
    ? 100
    : /subscription|account|openrouter|openai|anthropic|google|gemini|xai|mistral|cohere/.test(normalized)
      ? 48
      : 60;
  return {
    id: 'privacy',
    label: 'Privacy',
    score,
    weight: 15,
    summary: local
      ? 'Local/private route detected.'
      : 'Cloud/provider route; treat sensitive data according to provider policy.',
  };
}

export function latencyScore(
  local: boolean,
  benchmarkCompositeScore: number | null | undefined,
  providerHealth: ModelProviderHealthSignal,
  localBenchmarkLatency: LocalModelBenchmarkRouteLatency | null | undefined,
): ModelReadinessDimension {
  const liveLatency = providerHealth.status === 'record-found' ? providerHealth.avgLatencyMs : undefined;
  if (liveLatency !== undefined) {
    const score = liveLatency <= 750
      ? 95
      : liveLatency <= 1500
        ? 86
        : liveLatency <= 3000
          ? 72
          : 55;
    const details = [
      `Live provider-health latency is ${liveLatency} ms`,
      ...(providerHealth.minLatencyMs !== undefined || providerHealth.maxLatencyMs !== undefined
        ? [`range ${providerHealth.minLatencyMs ?? '?'}-${providerHealth.maxLatencyMs ?? '?'} ms`]
        : []),
      ...(providerHealth.healthStatus ? [`provider status ${providerHealth.healthStatus}`] : []),
      ...(providerHealth.lastErrorMessage ? [`last error: ${providerHealth.lastErrorMessage}`] : []),
    ];
    return {
      id: 'latency',
      label: 'Latency',
      score,
      weight: 20,
      summary: `${details.join('; ')}.`,
    };
  }

  if (localBenchmarkLatency && localBenchmarkLatency.status !== 'failed') {
    const latency = localBenchmarkLatency.latencyMs;
    const score = latency <= 750
      ? 93
      : latency <= 1500
        ? 84
        : latency <= 3000
          ? 70
          : 54;
    return {
      id: 'latency',
      label: 'Latency',
      score,
      weight: 20,
      summary: `Measured local benchmark latency is ${latency} ms from ${localBenchmarkLatency.artifactId}${localBenchmarkLatency.comparisonId ? ` (${localBenchmarkLatency.comparisonId})` : ''}.`,
    };
  }

  const score = local
    ? 55
    : benchmarkCompositeScore != null
      ? 78
      : 70;
  return {
    id: 'latency',
    label: 'Latency',
    score,
    weight: 20,
    summary: local
      ? 'Local latency is unmeasured until the user runs the benchmark prompt on this machine.'
      : benchmarkCompositeScore != null
        ? 'No daemon-published provider-health latency is reachable; benchmark metadata is quality context only.'
        : 'No daemon-published provider-health latency is reachable; assume normal provider latency until measured.',
  };
}

export function weightedReadiness(dimensions: readonly ModelReadinessDimension[]): number {
  const totalWeight = dimensions.reduce((total, dimension) => total + dimension.weight, 0);
  if (totalWeight <= 0) return 0;
  return clampFit(dimensions.reduce((total, dimension) => total + (dimension.score * dimension.weight), 0) / totalWeight);
}

export function modelReadinessScore(context: CommandContext, model: ModelCandidate): ModelRouteReadinessScore {
  const local = isLocalCandidate([model.providerId, model.registryKey, model.modelId, model.displayName]);
  const providerHealth = readProviderHealthSignal(context, model.providerId, model.registryKey);
  const dimensions: readonly ModelReadinessDimension[] = [
    latencyScore(local, model.benchmarkCompositeScore, providerHealth, model.localBenchmarkLatency),
    contextWindowScore(model.contextWindow),
    toolSupportScore(model.capabilities),
    visionScore(model.capabilities),
    costScore(model.tier, local),
    privacyScore(local, model.providerId),
  ];
  const score = weightedReadiness(dimensions);
  const hasLiveLatency = providerHealth.status === 'record-found' && providerHealth.avgLatencyMs !== undefined;
  const hasBenchmarkLatency = Boolean(model.localBenchmarkLatency && model.localBenchmarkLatency.status !== 'failed');
  const missingSignals = [
    ...providerHealth.missingSignals,
    ...(hasLiveLatency || hasBenchmarkLatency ? [] : ['No live latency benchmark has been recorded for this Agent route.']),
    ...(model.contextWindow == null ? ['Context-window metadata is missing.'] : []),
    ...(capabilityEnabled(model.capabilities, 'toolCalling') == null ? ['Tool-calling support is unknown.'] : []),
    ...(capabilityEnabled(model.capabilities, 'multimodal') == null ? ['Vision support is unknown.'] : []),
    ...(!model.tier && !local ? ['Cost tier is unknown.'] : []),
  ];
  return {
    score,
    level: modelReadinessLevel(score),
    confidence: providerHealth.status === 'record-found' && missingSignals.length === 0
      ? 'provider-health-backed'
      : hasBenchmarkLatency && missingSignals.length === 0
        ? 'measured'
      : missingSignals.length === 0
        ? 'metadata-backed'
        : 'estimated',
    dimensions,
    missingSignals,
    providerHealth,
    nextStep: local
      ? hasBenchmarkLatency
        ? `Review local benchmark latency evidence ${model.localBenchmarkLatency?.artifactId}, then use a separate confirmed apply/update route only if the user wants this route as default.`
        : 'Run the local benchmark prompt before making this route the default.'
      : providerHealth.status === 'record-found'
        ? 'Use provider-health-backed route posture for triage; run a task-specific comparison before changing the default model.'
        : hasBenchmarkLatency
          ? `Review benchmark latency evidence ${model.localBenchmarkLatency?.artifactId}; wait for daemon provider-health publication for live status, rate-limit, and error posture before changing defaults.`
        : 'Use this score for routing triage; wait for daemon provider-health publication or run a task-specific comparison before changing the default model.',
  };
}

export function localRecipeReadinessScore(
  recipe: LocalModelRecipe,
  fit: LocalModelRecipeFit,
  detected: boolean,
  evidence: LocalModelBenchmarkEvidence,
): ModelReadinessScore {
  const contextScore = recipe.id === 'vllm' ? 70 : recipe.id === 'openai-compatible-local' ? 60 : 65;
  const toolScore = recipe.id === 'ollama' || recipe.id === 'openai-compatible-local' ? 70 : 55;
  const visionSupport = recipe.modelExamples.some((model) => /vision|vl|multimodal/i.test(model));
  const reviewedWinner = evidence.winnerStacks.includes(localRecipeStackId(recipe));
  const measured = evidence.comparisonCount > 0;
  const dimensions: readonly ModelReadinessDimension[] = [
    {
      id: 'latency',
      label: 'Latency',
      score: reviewedWinner ? 82 : measured ? 68 : detected ? 62 : 50,
      weight: 20,
      summary: reviewedWinner
        ? 'A revealed saved local benchmark judgment selected this stack.'
        : measured
          ? 'A saved local benchmark comparison exists, but no revealed winner is tied to this stack yet.'
          : detected
            ? 'Local stack is detected, but latency still needs an on-machine benchmark.'
            : 'Latency is unknown until the local server and model are running.',
    },
    {
      id: 'context-window',
      label: 'Context window',
      score: contextScore,
      weight: 20,
      summary: 'Depends on the selected local model and serving stack; verify after the route is available.',
    },
    {
      id: 'tool-support',
      label: 'Tool support',
      score: toolScore,
      weight: 20,
      summary: 'Tool behavior depends on the selected local model and OpenAI-compatible server support.',
    },
    {
      id: 'vision',
      label: 'Vision',
      score: visionSupport ? 75 : 45,
      weight: 10,
      summary: visionSupport ? 'Example list includes a vision-capable route.' : 'No vision route is assumed for this local recipe.',
    },
    {
      id: 'cost',
      label: 'Cost',
      score: 100,
      weight: 15,
      summary: 'Local route; marginal token cost is user hardware and power.',
    },
    {
      id: 'privacy',
      label: 'Privacy',
      score: 100,
      weight: 15,
      summary: 'Local route can keep prompts on user-controlled hardware.',
    },
  ];
  const score = clampFit((weightedReadiness(dimensions) * 0.72) + (fit.score * 0.28));
  return {
    score,
    level: modelReadinessLevel(score),
    confidence: reviewedWinner ? 'measured' : 'estimated',
    dimensions,
    missingSignals: [
      ...(measured ? [] : ['No live latency benchmark has been recorded for this local recipe.']),
      ...(reviewedWinner ? [] : ['No revealed local benchmark judgment has selected this recipe yet.']),
      'Context window, tool support, and vision support depend on the exact model served.',
    ],
    nextStep: reviewedWinner
      ? 'Review the saved benchmark judgment, then use a separate confirmed apply/update route only if the user wants this winner as the default.'
      : measured
        ? 'Review the saved comparison and save a revealed judgment before recommending a default-model change.'
        : 'Start the local server, refresh models, then run the setupPlan benchmark action before changing the default model.',
  };
}

export function scoreLocalModelRecipe(
  recipe: LocalModelRecipe,
  hardware: LocalModelHardwareProfile,
  detection: LocalModelDetection,
): LocalModelRecipeFit {
  const stackId = localRecipeStackId(recipe);
  const detected = detection.stacks.includes(stackId);
  const reasons: string[] = [];
  let score = 45;
  if (detected) {
    score += 18;
    reasons.push('matching local provider or model route already detected');
  }
  if (recipe.id === 'ollama') {
    score += 20;
    reasons.push('lowest setup friction for most local users');
    if (hardware.ramGb >= 16) {
      score += 12;
      reasons.push(`${hardware.ramGb} GB RAM is enough for practical 7B/8B quantized models`);
    } else {
      score -= 10;
      reasons.push('RAM is below the comfortable 16 GB local-model baseline');
    }
    if (hardware.acceleratorHint === 'apple-silicon') {
      score += 10;
      reasons.push('Apple Silicon is a good Ollama path');
    }
  } else if (recipe.id === 'llama-cpp') {
    score += 16;
    reasons.push('best offline fallback when downloads and serving stay manual');
    if (hardware.ramGb >= 8) {
      score += 10;
      reasons.push('can use smaller GGUF quantized models within available system memory');
    }
    if (hardware.acceleratorHint === 'apple-silicon') {
      score += 8;
      reasons.push('Metal-backed llama.cpp is a strong local path on Apple Silicon');
    }
  } else if (recipe.id === 'vllm') {
    score += hardware.acceleratorHint === 'cuda-env' ? 30 : -12;
    reasons.push(hardware.acceleratorHint === 'cuda-env'
      ? 'CUDA environment hints are present'
      : 'no CUDA hint was detected; vLLM may still work, but requires GPU/driver verification');
    if (hardware.ramGb >= 32) {
      score += 10;
      reasons.push('system memory is comfortable for GPU serving overhead');
    }
  } else {
    score += detected ? 10 : 4;
    reasons.push(detected
      ? 'existing OpenAI-compatible local route can be reused'
      : 'useful when the user already runs LM Studio, LocalAI, TGI, or another local endpoint');
  }
  if (hardware.cpuThreads >= 8 && recipe.id !== 'vllm') {
    score += 5;
    reasons.push(`${hardware.cpuThreads} CPU threads help local inference`);
  }
  const finalScore = clampFit(score);
  return {
    score: finalScore,
    level: fitLevel(finalScore),
    reasons,
  };
}
