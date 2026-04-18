import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { getCocoProviderSettings } from '../settings';

export const COCO_DEFAULT_MODEL_OPTION = '__coco_default__';
const DEFAULT_CONTEXT_WINDOW = 128_000;

function readSavedProviderModel(settings: Record<string, unknown>): string {
  const saved = settings.savedProviderModel;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    return '';
  }
  const candidate = (saved as Record<string, unknown>).coco;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

export const cocoChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const opts: ProviderUIOption[] = [
      { value: COCO_DEFAULT_MODEL_OPTION, label: 'Use Coco default', description: 'Use coco.yaml model.name' },
    ];

    const cocoSettings = getCocoProviderSettings(settings);
    const configured = cocoSettings.defaultModel.trim();
    if (configured) {
      opts.unshift({ value: configured, label: configured, description: 'Custom (Claudian)' });
    }

    const active = typeof settings.model === 'string' ? settings.model.trim() : '';
    if (active && !opts.some(o => o.value === active)) {
      // Keep the currently-selected model visible even if it isn't in the saved list.
      opts.unshift({ value: active, label: active, description: 'Active' });
    }

    const envVars = getRuntimeEnvironmentVariables(settings, 'coco');
    const envModel = (envVars.COCO_MODEL_NAME ?? envVars.TRAECLI_MODEL_NAME ?? '').trim();
    if (envModel && !opts.some(o => o.value === envModel)) {
      opts.unshift({ value: envModel, label: envModel, description: 'Custom (env)' });
    }

    const savedModel = readSavedProviderModel(settings);
    if (savedModel && !opts.some(o => o.value === savedModel)) {
      opts.push({ value: savedModel, label: savedModel, description: 'Saved' });
    }

    // Deduplicate while preserving order.
    const seen = new Set<string>();
    return opts.filter((o) => {
      if (seen.has(o.value)) return false;
      seen.add(o.value);
      return true;
    });
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    return this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model);
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(): string {
    return 'off';
  },

  getContextWindowSize(_model: string, customLimits?: Record<string, number>): number {
    if (customLimits && typeof customLimits[_model] === 'number') {
      return customLimits[_model] as number;
    }
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return model === COCO_DEFAULT_MODEL_OPTION;
  },

  applyModelDefaults(): void {
    // No-op for Coco provider.
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.COCO_MODEL_NAME) {
      ids.add(envVars.COCO_MODEL_NAME);
    }
    if (envVars.TRAECLI_MODEL_NAME) {
      ids.add(envVars.TRAECLI_MODEL_NAME);
    }
    return ids;
  },
};
