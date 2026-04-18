import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getCocoProviderSettings, updateCocoProviderSettings } from '../settings';

const ENV_HASH_PATTERNS: RegExp[] = [
  /^COCO_/i,
  /^TRAECLI_/i,
];

function computeCocoEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return Object.keys(envVars)
    .filter(key => ENV_HASH_PATTERNS.some(pattern => pattern.test(key)))
    .sort()
    .map(key => `${key}=${envVars[key]}`)
    .join('|');
}

export const cocoSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'coco');
    const currentHash = computeCocoEnvHash(envText);
    const savedHash = getCocoProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conv of conversations) {
      if (conv.providerId !== 'coco') continue;
      if (conv.sessionId || conv.providerState) {
        conv.sessionId = null;
        conv.providerState = undefined;
        invalidatedConversations.push(conv);
      }
    }

    updateCocoProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(): boolean {
    return false;
  },
};
