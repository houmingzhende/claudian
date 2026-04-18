import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation, ForkSource } from '../../../core/types';

function isForkSource(value: unknown): value is ForkSource {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'sessionId' in value
    && 'resumeAt' in value;
}

function getForkSource(providerState: Record<string, unknown> | undefined): ForkSource | null {
  if (!providerState || typeof providerState !== 'object' || Array.isArray(providerState)) {
    return null;
  }
  const candidate = (providerState as Record<string, unknown>).forkSource;
  return isForkSource(candidate) ? candidate : null;
}

export class CocoConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // MVP: no transcript hydration. Claudian persists messages itself.
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // MVP: do not delete anything outside Claudian.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    if (conversation.providerId !== 'coco') {
      return false;
    }
    const forkSource = getForkSource(conversation.providerState);
    return !!forkSource && !conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
  ): Record<string, unknown> {
    return {
      forkSource: {
        sessionId: sourceSessionId,
        resumeAt,
      },
    };
  }
}

