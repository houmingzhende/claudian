import '@/providers';

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { CocoChatRuntime } from '@/providers/coco/runtime/CocoChatRuntime';
import { COCO_DEFAULT_MODEL_OPTION } from '@/providers/coco/ui/CocoChatUIConfig';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

class MockProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

describe('CocoChatRuntime model selection', () => {
  beforeEach(() => {
    ProviderWorkspaceRegistry.clear();
    ProviderWorkspaceRegistry.setServices('coco', {
      cliResolver: { resolveFromSettings: () => '/Users/bytedance/.local/bin/coco', reset: () => {} },
    } as any);
  });

  it('does not pass Claude model to coco when coco snapshot uses default sentinel', async () => {
    const proc = new MockProc();
    (spawn as unknown as jest.Mock).mockReturnValue(proc as any);

    const plugin: any = {
      settings: {
        settingsProvider: 'claude',
        model: 'haiku',
        sharedEnvironmentVariables: '',
        providerConfigs: {
          coco: { enabled: true },
        },
        savedProviderModel: {
          coco: COCO_DEFAULT_MODEL_OPTION,
        },
      },
      getResolvedProviderCliPath: () => '/Users/bytedance/.local/bin/coco',
    };

    const runtime = new CocoChatRuntime(plugin);
    const gen = runtime.query({
      request: { text: 'hi' },
      persistedContent: 'hi',
      prompt: 'hi',
      isCompact: false,
      mcpMentions: new Set(),
    } as any);

    // First yield is the assistant message start (spawn has not executed yet).
    const first = await gen.next();
    expect(first.value.type).toBe('assistant_message_start');

    // Advance to trigger spawn and then close the process.
    const pending = gen.next();
    proc.emit('close', 0, null);
    const second = await pending;
    expect(second.value.type).toBe('done');

    // Ensure we didn't pass `--config model.name=haiku`.
    const args = (spawn as unknown as jest.Mock).mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).not.toContain('model.name=haiku');
  });
});
