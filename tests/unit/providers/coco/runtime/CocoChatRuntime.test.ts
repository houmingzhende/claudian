import '@/providers';

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { CocoChatRuntime } from '@/providers/coco/runtime/CocoChatRuntime';
import { COCO_DEFAULT_MODEL_OPTION } from '@/providers/coco/ui/CocoChatUIConfig';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

class MockProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { write: jest.fn() };
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
      app: { vault: { adapter: { basePath: '/tmp' } } },
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

    // Helper to read the last JSON-RPC request we wrote to stdin.
    const readLastRequest = () => {
      const calls = (proc.stdin.write as jest.Mock).mock.calls;
      const last = calls[calls.length - 1]?.[0] as string;
      return JSON.parse(String(last).trim());
    };

    const waitForWrites = async (minCalls: number) => {
      while ((proc.stdin.write as jest.Mock).mock.calls.length < minCalls) {
        await new Promise((r) => setImmediate(r));
      }
    };

    // Start the generator; it blocks in ensureReady until initialize resolves.
    const firstPromise = gen.next();

    // initialize
    await waitForWrites(1);
    const initReq = readLastRequest();
    expect(initReq.method).toBe('initialize');
    proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: { protocolVersion: 1 } }) + '\n');

    const first = await firstPromise;
    expect(first.value.type).toBe('assistant_message_start');

    // Advance the generator to trigger session/new + session/prompt
    const secondPromise = gen.next();

    // session/new
    await waitForWrites(2);
    const newReq = readLastRequest();
    expect(newReq.method).toBe('session/new');
    proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: newReq.id, result: { sessionId: 'sid_test' } }) + '\n');

    // session/prompt
    await waitForWrites(3);
    const promptReq = readLastRequest();
    expect(promptReq.method).toBe('session/prompt');

    // Ensure we didn't pass modelId=haiku.
    expect(promptReq.params.modelId).toBeUndefined();

    // Finish prompt
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: promptReq.id,
      result: { stopReason: 'end_turn' },
    }) + '\n');

    const second = await secondPromise;
    expect(second.value.type).toBe('done');

    runtime.cleanup();
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('exit', 0);
  });
});

describe('CocoChatRuntime session/update normalization', () => {
  beforeEach(() => {
    ProviderWorkspaceRegistry.clear();
    ProviderWorkspaceRegistry.setServices('coco', {
      cliResolver: { resolveFromSettings: () => 'coco', reset: () => {} },
    } as any);
  });

  it('maps tool_call/tool_call_update + agent_message_chunk to stream chunks', async () => {
    const proc = new MockProc();
    (spawn as unknown as jest.Mock).mockReturnValue(proc as any);

    const plugin: any = {
      app: { vault: { adapter: { basePath: '/tmp' } } },
      settings: {
        settingsProvider: 'coco',
        model: COCO_DEFAULT_MODEL_OPTION,
        sharedEnvironmentVariables: '',
        providerConfigs: {
          coco: { enabled: true },
        },
      },
      getResolvedProviderCliPath: () => 'coco',
    };

    const runtime = new CocoChatRuntime(plugin);
    const gen = runtime.query({
      request: { text: 'hi' },
      persistedContent: 'hi',
      prompt: 'hi',
      isCompact: false,
      mcpMentions: new Set(),
    } as any);

    const readLastRequest = () => {
      const calls = (proc.stdin.write as jest.Mock).mock.calls;
      const last = calls[calls.length - 1]?.[0] as string;
      return JSON.parse(String(last).trim());
    };

    const waitForWrites = async (minCalls: number) => {
      while ((proc.stdin.write as jest.Mock).mock.calls.length < minCalls) {
        await new Promise((r) => setImmediate(r));
      }
    };

    const firstPromise = gen.next();

    // initialize
    await waitForWrites(1);
    const initReq = readLastRequest();
    proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: { protocolVersion: 1 } }) + '\n');

    expect((await firstPromise).value.type).toBe('assistant_message_start');

    const secondPromise = gen.next();

    // session/new
    await waitForWrites(2);
    const newReq = readLastRequest();
    proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: newReq.id, result: { sessionId: 'sid_test' } }) + '\n');

    // session/prompt
    await waitForWrites(3);
    const promptReq = readLastRequest();
    expect(promptReq.method).toBe('session/prompt');

    // tool_call
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid_test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool_1',
          title: 'bash',
          rawInput: { Command: 'echo hi' },
        },
      },
    }) + '\n');

    // tool_call_update
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid_test',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
        },
      },
    }) + '\n');

    // agent_message_chunk
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid_test',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        },
      },
    }) + '\n');

    // Finish prompt
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: promptReq.id,
      result: { stopReason: 'end_turn' },
    }) + '\n');

    const chunks = [await secondPromise, await gen.next(), await gen.next(), await gen.next()];
    expect(chunks[0].value).toMatchObject({ type: 'tool_use', id: 'tool_1', name: 'bash' });
    expect(chunks[1].value).toMatchObject({ type: 'tool_result', id: 'tool_1', content: 'hi\n' });
    expect(chunks[2].value).toMatchObject({ type: 'text', content: 'ok' });
    expect(chunks[3].value.type).toBe('done');

    runtime.cleanup();
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('exit', 0);
  });
});
