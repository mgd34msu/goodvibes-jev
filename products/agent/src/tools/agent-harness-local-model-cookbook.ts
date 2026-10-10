import type { CommandContext } from '../input/command-registry.ts';
import { estimateModelBytes, fitAssessment, fitVerdictLabel, readHardwareProfileSync, REPRESENTATIVE_7B_PARAMS } from '../core/hardware-profile.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { localModelDetection, localModelServerHealthMap } from './agent-harness-local-model-endpoints.ts';
import { deferredModelReadiness, deferredRecipeFit, localHardwareProfile, localRecipeReadinessScore, localRecipeStackId, scoreLocalModelRecipe } from './agent-harness-model-readiness.ts';
import { localModelBenchmarkHistory, localModelBenchmarkPlan } from './agent-harness-local-model-benchmarks.ts';
import type { LocalModelDetection, LocalModelHardwareProfile, LocalModelRecipe, LocalModelRecipeFit, LocalModelSetupPlan, LocalModelBenchmarkEvidence, ModelReadinessScore } from './agent-harness-model-routing-types.ts';
import { routeReadiness } from '@goodvibes-jev/engine/sdk/platform/routing';
import { withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';

export function localModelDownloadGuidance(recipe: LocalModelRecipe, hardware: LocalModelHardwareProfile): readonly string[] {
  if (recipe.id === 'ollama') {
    const model = hardware.ramGb >= 32 ? 'qwen2.5-coder:14b' : 'qwen2.5-coder:7b';
    return [
      'Install Ollama from the vendor package or package manager.',
      'Start the Ollama service before refreshing Agent models.',
      `Suggested first pull: ollama pull ${model}`,
      `Smoke test: ollama run ${model} "Say ready in one sentence."`,
    ];
  }
  if (recipe.id === 'llama-cpp') {
    return [
      'Choose a GGUF model that fits available RAM; prefer Q4/Q5 quantization on constrained systems.',
      'Download the GGUF from the model publisher or a trusted mirror.',
      'Start an OpenAI-compatible server: llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080',
      'Smoke test the /v1/models endpoint before adding the provider route.',
    ];
  }
  if (recipe.id === 'vllm') {
    return [
      'Verify CUDA driver, GPU memory, and Python environment before installing vLLM.',
      'Install vLLM in an isolated environment.',
      'Serve a small first model: python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen2.5-Coder-7B-Instruct --host 127.0.0.1 --port 8000',
      'Smoke test /v1/models before adding the provider route.',
    ];
  }
  return [
    'Start the local OpenAI-compatible server in its own app or service.',
    'Confirm the server exposes /v1/models and a private localhost or trusted LAN base URL.',
    'Use the server app to download or load the model before adding it to Agent.',
    'Keep LAN endpoints private unless the user explicitly intends shared access.',
  ];
}

export function localModelProviderRoutes(recipe: LocalModelRecipe): readonly string[] {
  if (recipe.id === 'ollama') {
    return [
      'agent_harness mode:"open_ui_surface" surfaceId:"provider-picker" confirm:true explicitUserRequest:"Select the discovered Ollama route."',
      'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh models after starting Ollama."',
    ];
  }
  if (recipe.id === 'llama-cpp') {
    return [
      'agent_harness mode:"run_command" command:"/provider add llama-cpp-local http://127.0.0.1:8080/v1 local --yes" confirm:true explicitUserRequest:"Add a local llama.cpp OpenAI-compatible provider."',
      'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh models after starting llama.cpp."',
    ];
  }
  if (recipe.id === 'vllm') {
    return [
      'agent_harness mode:"run_command" command:"/provider add vllm-local http://127.0.0.1:8000/v1 local --yes" confirm:true explicitUserRequest:"Add a local vLLM OpenAI-compatible provider."',
      'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh models after starting vLLM."',
    ];
  }
  return [
    'agent_harness mode:"run_command" command:"/provider add local-openai http://127.0.0.1:1234/v1 local --yes" confirm:true explicitUserRequest:"Add a local OpenAI-compatible provider."',
    'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh models after starting the local server."',
  ];
}

export function localModelSetupPlan(
  recipe: LocalModelRecipe,
  hardware: LocalModelHardwareProfile,
  detection: LocalModelDetection,
  fit: LocalModelRecipeFit,
  readiness: ModelReadinessScore = deferredModelReadiness(),
): LocalModelSetupPlan {
  const stackId = localRecipeStackId(recipe);
  const detected = detection.stacks.includes(stackId);
  return {
    status: detected ? 'detected' : fit.outcome !== 'ready' || fit.score === null || readiness.outcome !== 'ready' ? 'unknown' : fit.level === 'weak' ? 'needs-hardware-review' : 'ready-to-try',
    priority: fit.score,
    downloadGuidance: localModelDownloadGuidance(recipe, hardware),
    providerRoutes: localModelProviderRoutes(recipe),
    benchmarkPlan: localModelBenchmarkPlan(recipe),
    confirmationBoundary: 'The plan is read-only guidance. Installs, downloads, server starts, provider edits, refreshes, comparisons, and route changes require explicit user action or confirmation.',
  };
}

/**
 * Representative Q4 parameter count for a recipe's default/starter model.
 * Used to estimate memory footprint for hardware fit annotation.
 * Returns null for stacks where size is too variable to estimate safely.
 */
function recipeRepresentativeParamCount(recipe: LocalModelRecipe): number | null {
  // Uses the shared REPRESENTATIVE_7B_PARAMS constant so the renderer and cookbook
  // always reference the same basis.
  // The generic openai-compatible stack is too varied to estimate.
  if (recipe.id === 'ollama' || recipe.id === 'llama-cpp' || recipe.id === 'vllm') {
    return REPRESENTATIVE_7B_PARAMS;
  }
  return null;
}

export function localModelRecipes(): readonly LocalModelRecipe[] {
  return [
    {
      id: 'ollama',
      label: 'Ollama',
      fit: 'Best first local route for most users.',
      bestFor: 'Fast setup, chat, coding help, private everyday assistant work.',
      hardware: 'Usable on modern CPU or Apple Silicon; 16 GB RAM is comfortable for 7B/8B quantized models, 32 GB+ for 14B/32B.',
      setup: [
        'Install Ollama and start the local service.',
        'Pull one practical model, such as qwen2.5-coder:7b or llama3.1:8b.',
        'Refresh models in GoodVibes Agent, then choose the discovered ollama:<model> route.',
      ],
      modelExamples: ['qwen2.5-coder:7b', 'llama3.1:8b', 'mistral:7b'],
      cautions: ['Large models may run slowly without enough memory.', 'Use vLLM instead when the goal is multi-user throughput.'],
    },
    {
      id: 'llama-cpp',
      label: 'llama.cpp',
      fit: 'Best low-dependency offline route.',
      bestFor: 'CPU/Metal inference, GGUF files, portable offline use, constrained machines.',
      hardware: 'Works without a GPU; use Q4/Q5 GGUF files for small systems and larger quantization only when memory allows.',
      setup: [
        'Download a GGUF model that fits memory.',
        'Run llama-server with an OpenAI-compatible endpoint.',
        'Add or refresh the local OpenAI-compatible provider, then select it in the model picker.',
      ],
      modelExamples: ['Qwen2.5-Coder 7B Instruct GGUF', 'Llama 3.1 8B Instruct GGUF', 'Phi-3 Mini GGUF'],
      cautions: ['Manual model-file choice matters more than with Ollama.', 'Throughput is lower than GPU serving.'],
    },
    {
      id: 'vllm',
      label: 'vLLM',
      fit: 'Best high-throughput local or LAN server route.',
      bestFor: 'NVIDIA GPU serving, batching, OpenAI-compatible APIs, team/shared local models.',
      hardware: 'Prefer CUDA GPUs; 16 GB VRAM can serve small quantized models, 24-48 GB+ is better for larger coder models.',
      setup: [
        'Install vLLM in a CUDA-ready Python environment.',
        'Serve a model with the OpenAI-compatible API server.',
        'Add the endpoint as a custom provider and select that route.',
      ],
      modelExamples: ['Qwen2.5-Coder 7B Instruct', 'Llama 3.1 8B Instruct', 'DeepSeek Coder V2 Lite'],
      cautions: ['Not the easiest first setup.', 'GPU drivers and model memory limits are the common failure points.'],
    },
    {
      id: 'openai-compatible-local',
      label: 'Local OpenAI-compatible server',
      fit: 'Best when the user already has LM Studio, LocalAI, TGI, or another local endpoint.',
      bestFor: 'Reusing an existing localhost or LAN model server through one familiar API.',
      hardware: 'Depends on the server backend; verify context window and memory in the serving app first.',
      setup: [
        'Start the local server and confirm its /v1/models endpoint works.',
        'Add a custom provider with the local base URL.',
        'Refresh models and select the discovered route.',
      ],
      modelExamples: ['LM Studio loaded model', 'LocalAI model', 'TGI-served model'],
      cautions: ['Some servers omit context-window metadata.', 'Keep LAN endpoints private unless explicitly intended.'],
    },
  ];
}

export function describeLocalModelRecipe(
  recipe: LocalModelRecipe,
  detection: LocalModelDetection,
  hardware: LocalModelHardwareProfile,
  benchmarkEvidence: LocalModelBenchmarkEvidence,
  includeParameters: boolean,
  fit: LocalModelRecipeFit = deferredRecipeFit(),
  readiness: ModelReadinessScore = deferredModelReadiness(),
): Record<string, unknown> {
  const stackId = localRecipeStackId(recipe);
  const detected = detection.stacks.includes(stackId);
  return {
    id: recipe.id,
    label: recipe.label,
    fit: recipe.fit,
    fitScore: fit.score,
    fitLevel: fit.level,
    fitReading: fit,
    readinessScore: readiness.score,
    readinessLevel: readiness.level,
    readiness: includeParameters
      ? readiness
      : {
        score: readiness.score,
        level: readiness.level,
        confidence: readiness.confidence,
        outcome: readiness.outcome,
        decisionId: readiness.decisionId,
        nextStep: readiness.nextStep,
      },
    bestFor: recipe.bestFor,
    hardware: previewHarnessText(recipe.hardware, includeParameters ? 180 : 96),
    hardwareMatched: fit.reasons.slice(0, includeParameters ? 6 : 3),
    detected,
    modelRoute: 'models action:"status" or agent_harness mode:"open_ui_surface"',
    ...(() => {
      const paramCount = recipeRepresentativeParamCount(recipe);
      if (paramCount === null) return {};
      const sizeBytes = estimateModelBytes(paramCount);
      const label = fitVerdictLabel(fitAssessment(sizeBytes, readHardwareProfileSync()));
      return label ? { hardwareFit: label } : {};
    })(),
    ...(includeParameters ? {
      setup: recipe.setup,
      modelExamples: recipe.modelExamples,
      cautions: recipe.cautions,
      setupPlan: localModelSetupPlan(recipe, hardware, detection, fit, readiness),
    } : {}),
  };
}

export function localModelCookbook(context: CommandContext, includeParameters: boolean): Record<string, unknown> {
  return cookbookSnapshot(context, includeParameters);
}

function cookbookSnapshot(context: CommandContext, includeParameters: boolean, enriched?: readonly Record<string, unknown>[], hardware?: LocalModelHardwareProfile): Record<string, unknown> {
  const detection = localModelDetection(context);
  const hardwareProfile = hardware ?? localHardwareProfile();
  const benchmarkHistory = localModelBenchmarkHistory(context, includeParameters);
  const benchmarkEvidence = readRecord(benchmarkHistory.evidence) as unknown as LocalModelBenchmarkEvidence;
  const localServerHealth = localModelServerHealthMap(context, includeParameters);
  const recipes = enriched ?? localModelRecipes()
    .map((recipe) => describeLocalModelRecipe(recipe, detection, hardwareProfile, benchmarkEvidence, includeParameters));
  const ready = recipes.filter(recipe => readRecord(recipe.fitReading).outcome === 'ready'
    && readRecord(recipe.readiness).outcome === 'ready' && typeof recipe.readinessScore === 'number');
  const topRecipe = ready[0];
  const topLabel = topRecipe ? readString(topRecipe.label) : null;
  const nextActions = [
    localServerHealth.endpointCount > 0
      ? `Smoke test detected local endpoint(s): ${localServerHealth.endpoints[0]?.modelsUrl ?? 'see localServerHealth.endpoints'}.`
      : detection.stacks.length > 0
      ? `Inspect detected local route(s): ${detection.modelRoutes.join(', ') || detection.providerIds.join(', ')}.`
      : topLabel ? `Review ${topLabel} and its setupPlan before any installation.`
      : 'Recipe readiness is unknown. Inspect hardware requirements and gather exact route and benchmark evidence.',
    'Refresh the model catalog after the local server is running.',
    'Run the local benchmark workspace action or saved model comparison before changing the default route.',
  ];
  return {
    status: detection.stacks.length > 0
      ? 'detected-local-route'
      : localServerHealth.endpointCount > 0
        ? 'detected-local-server'
        : 'recommendations-only',
    recommendation: topLabel ? `Best settled fit: ${topLabel}. Review its evidence before choosing a route.` : null,
    enrichment: enriched ? 'read' : 'deferred',
    hardwareProfile,
    detected: detection,
    localServerHealth,
    recipes,
    benchmarkHistory,
    readinessRubric: {
      score: '0-100 from settled rubric readings only; null when evidence or a reading is missing.',
      battery: 'agent.models.route-readiness',
      dimensions: routeReadiness.composite.dimensions.map(({ id, weight }) => ({ id, weight })),
    },
    nextActions,
    modelRoute: 'models action:"local"',
    policy: 'Read-only hardware-aware cookbook. Readiness enrichment is deferred in synchronous startup snapshots and unknown when evidence or readings are unsettled. Setup plans include download/start guidance and a confirmed benchmark action route, but installs, downloads, live benchmarks, provider edits, and route changes stay separate visible user actions.',
  };
}

/** Explicit inspection may enrich facts; startup and setup snapshots never ask a model. */
export async function readLocalModelCookbook(context: CommandContext, includeParameters: boolean, options: ModelReadingOptions): Promise<Record<string, unknown>> {
  const recipes = localModelRecipes(), hardware = localHardwareProfile(), detection = localModelDetection(context);
  const history = localModelBenchmarkHistory(context, true);
  const evidence = readRecord(history.evidence) as unknown as LocalModelBenchmarkEvidence;
  return withModelReadingSource({ recipes, hardware, detection, evidence }, options, async (facts, scoped) => {
    const enriched: Record<string, unknown>[] = [];
    for (const recipe of facts.recipes) {
      const fit = await scoreLocalModelRecipe(recipe, facts.hardware, facts.detection, scoped);
      scoped.assertCurrent?.();
      const readiness = await localRecipeReadinessScore(recipe, fit, facts.detection.stacks.includes(localRecipeStackId(recipe)), facts.evidence, scoped);
      scoped.assertCurrent?.();
      enriched.push(describeLocalModelRecipe(recipe, facts.detection, facts.hardware, facts.evidence, includeParameters, fit, readiness));
    }
    // Explicit null handling: missing scores stay at the end and never become zero.
    enriched.sort((a, b) => typeof a.fitScore !== 'number' ? typeof b.fitScore !== 'number' ? 0 : 1
      : typeof b.fitScore !== 'number' ? -1 : b.fitScore - a.fitScore);
    const result = cookbookSnapshot(context, includeParameters, enriched, facts.hardware);
    scoped.assertCurrent?.(); return result;
  });
}
