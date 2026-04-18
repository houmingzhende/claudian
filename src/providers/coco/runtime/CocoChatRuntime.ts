import { type ChildProcessWithoutNullStreams,spawn } from 'child_process';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { COCO_PROVIDER_CAPABILITIES } from '../capabilities';
import { getCocoProviderSettings } from '../settings';
import { COCO_DEFAULT_MODEL_OPTION } from '../ui/CocoChatUIConfig';

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;
  private error: Error | null = null;

  push(item: T): void {
    if (this.done) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined as unknown as T, done: true });
    }
  }

  fail(err: Error): void {
    if (this.done) return;
    this.error = err;
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined as unknown as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false };
    }
    if (this.done) {
      if (this.error) {
        throw this.error;
      }
      return { value: undefined as unknown as T, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

function buildCocoPrompt(turn: PreparedChatTurn, history: ChatMessage[] | undefined): string {
  if (!history || history.length === 0) {
    return turn.prompt;
  }

  const parts: string[] = [];
  for (const msg of history) {
    const roleLabel = msg.role === 'assistant' ? 'Assistant' : 'User';
    const content = (msg.content ?? '').trim();
    if (!content) continue;
    parts.push(`${roleLabel}: ${content}`);
  }
  parts.push(`User: ${turn.prompt.trim()}`);
  parts.push('Assistant:');
  return parts.join('\n\n');
}

function spawnCocoPrint(
  cliPath: string,
  prompt: string,
  options: {
    modelName?: string;
    env: Record<string, string | undefined>;
  },
): ChildProcessWithoutNullStreams {
  const args: string[] = ['--print'];
  if (options.modelName) {
    args.push('--config', `model.name=${options.modelName}`);
  }
  args.push(prompt);

  return spawn(cliPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

export class CocoChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'coco';

  private plugin: ClaudianPlugin;
  private ready = true;
  private readyListeners = new Set<(ready: boolean) => void>();

  private activeProc: ChildProcessWithoutNullStreams | null = null;
  private activeQueue: AsyncQueue<StreamChunk> | null = null;
  private canceled = false;

  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private turnMetadata: ChatTurnMetadata = {};

  // Unused MVP hooks (kept for interface compliance)
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;
  private resumeCheckpoint: string | undefined;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return COCO_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      request,
      persistedContent: request.text,
      prompt: request.text,
      isCompact: false,
      mcpMentions: new Set<string>(),
    };
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.turnMetadata };
    this.turnMetadata = {};
    return metadata;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  private setReady(next: boolean): void {
    if (this.ready === next) return;
    this.ready = next;
    for (const listener of this.readyListeners) {
      listener(next);
    }
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.resumeCheckpoint = checkpointId;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    this.sessionId = conversation?.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    // MVP: coco manages its own tools; Claudian does not inject MCP servers.
  }

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const cocoSettings = getCocoProviderSettings(settings);
    if (!cocoSettings.enabled) {
      this.setReady(false);
      return false;
    }
    this.setReady(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.canceled = false;
    this.turnMetadata = { wasSent: true };

    const ensured = await this.ensureReady({ force: queryOptions?.forceColdStart });
    if (!ensured) {
      yield { type: 'error', content: 'Coco provider is disabled. Enable it in settings.' };
      yield { type: 'done' };
      return;
    }

    // Cancel any previous running process.
    if (this.activeProc) {
      this.cancel();
    }

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const envVars = getRuntimeEnvironmentVariables(settings, 'coco');
    const cliResolver = ProviderWorkspaceRegistry.getCliResolver('coco');
    const cliPath = cliResolver?.resolveFromSettings(settings) ?? 'coco';
    const prompt = buildCocoPrompt(turn, conversationHistory);

    const modelFromOptions = (queryOptions?.model ?? settings.model) as string | undefined;
    const model = typeof modelFromOptions === 'string' ? modelFromOptions.trim() : '';
    const modelName = (model && model !== COCO_DEFAULT_MODEL_OPTION) ? model : undefined;

    const queue = new AsyncQueue<StreamChunk>();
    this.activeQueue = queue;

    yield { type: 'assistant_message_start' };

    const proc = spawnCocoPrint(cliPath, prompt, { modelName, env: envVars });
    this.activeProc = proc;

    const stderrChunks: string[] = [];
    let finished = false;

    const finishOnce = (handler: () => void) => {
      if (finished) return;
      finished = true;
      handler();
    };

    proc.stdout.on('data', (data: Buffer) => {
      if (this.canceled) return;
      const text = data.toString('utf8');
      if (text) {
        queue.push({ type: 'text', content: text });
      }
    });

    proc.stdout.on('error', (err) => {
      if (this.canceled) return;
      queue.push({ type: 'error', content: String(err) });
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString('utf8'));
    });

    proc.on('exit', (code, signal) => {
      finishOnce(() => {
        const stderr = stderrChunks.join('').trim();
        if (!this.canceled && code && code !== 0) {
          queue.push({
            type: 'error',
            content: stderr || `coco exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
          });
        }
        queue.push({ type: 'done' });
        queue.finish();
      });
    });

    try {
      for await (const chunk of queue) {
        yield chunk;
      }
    } finally {
      this.activeProc = null;
      this.activeQueue = null;
      finishOnce(() => {
        queue.finish();
      });
    }
  }

  cancel(): void {
    this.canceled = true;
    const proc = this.activeProc;
    if (!proc) return;

    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.activeProc = null;
    this.activeQueue?.push({ type: 'notice', content: 'Canceled.' });
    this.activeQueue?.push({ type: 'done' });
    this.activeQueue?.finish();
    this.sessionInvalidated = true;
  }

  resetSession(): void {
    this.cancel();
    this.sessionId = null;
    this.sessionInvalidated = true;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const value = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return value;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.cancel();
    this.readyListeners.clear();
  }

  async rewind(_userMessageId: string, _assistantMessageId: string): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Coco rewind is not supported.' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.subagentHookProvider = getState;
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    // MVP: Claudian-side persistence only. We don't create coco-native sessions.
    // When a cancellation happens, we can clear the sessionId to avoid implying resumption.
    if (params.sessionInvalidated) {
      return { updates: { sessionId: null } };
    }
    return { updates: {} };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }
}
