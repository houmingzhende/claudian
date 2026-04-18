import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameCliPaths = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}

export interface CocoProviderSettings {
  enabled: boolean;

  /** Optional explicit path or command name for coco binary. */
  cliPath: string;
  /** Host-scoped overrides (preferred). */
  cliPathsByHost: HostnameCliPaths;

  /** Optional model name to pass via `--config model.name=<name>`. */
  defaultModel: string;

  /** Optional list of models shown in the model dropdown (newline/comma-separated). */
  modelOptions: string;

  /** Provider-scoped environment variables (legacy mirror; canonical lives in providerEnvironment). */
  environmentVariables: string;
  /** Hash of provider-scoped environment variables used to invalidate sessions. */
  environmentHash: string;
}

export const DEFAULT_COCO_PROVIDER_SETTINGS: Readonly<CocoProviderSettings> = Object.freeze({
  enabled: false,
  cliPath: '',
  cliPathsByHost: {},
  defaultModel: '',
  modelOptions: '',
  environmentVariables: '',
  environmentHash: '',
});

export function getCocoProviderSettings(settings: Record<string, unknown>): CocoProviderSettings {
  const config = getProviderConfig(settings, 'coco');
  const hostnameKey = getHostnameKey();
  const cliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const hostCliPath = typeof cliPathsByHost[hostnameKey] === 'string'
    ? cliPathsByHost[hostnameKey]?.trim()
    : '';

  return {
    enabled: (config.enabled as boolean | undefined)
      ?? DEFAULT_COCO_PROVIDER_SETTINGS.enabled,
    cliPath: hostCliPath || normalizeOptionalString(config.cliPath) || DEFAULT_COCO_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    defaultModel: normalizeOptionalString(config.defaultModel) || DEFAULT_COCO_PROVIDER_SETTINGS.defaultModel,
    modelOptions: normalizeOptionalString(config.modelOptions) || DEFAULT_COCO_PROVIDER_SETTINGS.modelOptions,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'coco')
      ?? DEFAULT_COCO_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? DEFAULT_COCO_PROVIDER_SETTINGS.environmentHash,
  };
}

export function updateCocoProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CocoProviderSettings>,
): CocoProviderSettings {
  const current = getCocoProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const cliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };

  if ('cliPath' in updates) {
    const legacyCliPath = normalizeOptionalString(updates.cliPath);
    if (legacyCliPath && Object.keys(cliPathsByHost).length === 0) {
      // If a legacy path is set and no host overrides exist, preserve it.
      cliPathsByHost[hostnameKey] = legacyCliPath;
    }
  }

  const next: CocoProviderSettings = {
    ...current,
    ...updates,
    cliPath: 'cliPath' in updates ? normalizeOptionalString(updates.cliPath) : current.cliPath,
    cliPathsByHost,
    defaultModel: 'defaultModel' in updates ? normalizeOptionalString(updates.defaultModel) : current.defaultModel,
    modelOptions: 'modelOptions' in updates ? normalizeOptionalString(updates.modelOptions) : current.modelOptions,
  };

  setProviderConfig(settings, 'coco', {
    enabled: next.enabled,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    defaultModel: next.defaultModel,
    modelOptions: next.modelOptions,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
  });
  return next;
}
