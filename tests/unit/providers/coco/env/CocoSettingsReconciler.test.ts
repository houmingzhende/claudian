import type { Conversation } from '../../../../../src/core/types';
import { cocoSettingsReconciler } from '../../../../../src/providers/coco/env/CocoSettingsReconciler';
import { getCocoProviderSettings } from '../../../../../src/providers/coco/settings';

describe('cocoSettingsReconciler', () => {
  it('invalidates coco conversations when environment changes', () => {
    const settings: Record<string, unknown> = {
      sharedEnvironmentVariables: '',
      providerConfigs: {
        coco: {
          enabled: true,
          environmentHash: '',
          environmentVariables: 'COCO_NEXTCODE_URL=https://example.invalid',
        },
      },
    };

    const conversations: Conversation[] = [
      {
        id: '1',
        providerId: 'coco',
        title: 't',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: 'some-session',
        providerState: { foo: 'bar' },
        messages: [],
      },
      {
        id: '2',
        providerId: 'claude',
        title: 't2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: 'x',
        providerState: undefined,
        messages: [],
      },
    ];

    const result = cocoSettingsReconciler.reconcileModelWithEnvironment(settings, conversations);
    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toHaveLength(1);
    expect(conversations[0]?.sessionId).toBe(null);
    expect(conversations[0]?.providerState).toBe(undefined);
    expect(getCocoProviderSettings(settings).environmentHash).not.toBe('');
    expect(getCocoProviderSettings(settings).noOutputTimeoutSeconds).toBe(300);
  });
});
