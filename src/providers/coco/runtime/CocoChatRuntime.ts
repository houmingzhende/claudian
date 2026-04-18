import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
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
import { getVaultPath } from '../../../utils/path';
import { COCO_PROVIDER_CAPABILITIES } from '../capabilities';
import { getCocoProviderSettings } from '../settings';
import { COCO_DEFAULT_MODEL_OPTION } from '../ui/CocoChatUIConfig';

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type NotificationHandler = (params: unknown) => void;

class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private disposed = false;
  private rl: ReadlineInterface | null = null;

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {}

  start(): void {
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    this.proc.on('exit', () => {
      this.rl?.close();
      this.rl = null;
      this.rejectAllPending(new Error('ACP server process exited'));
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
        }, timeoutMs)
        : null;

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      this.sendRaw(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.sendRaw(msg);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  dispose(): void {
    this.disposed = true;
    this.rl?.close();
    this.rl = null;
    this.rejectAllPending(new Error('Transport disposed'));
  }

  private sendRaw(msg: unknown): void {
    if (this.disposed) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    // Server response to our request
    if (typeof id === 'number' && !method) {
      this.handleResponse(id, msg);
      return;
    }

    // Server notification
    if (method && msg.id === undefined) {
      const handler = this.notificationHandlers.get(method);
      if (handler) handler(msg.params);
    }
  }

  private handleResponse(id: number, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    if (msg.error) {
      const err = msg.error as JsonRpcError;
      pending.reject(new Error(err.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

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

function spawnCocoAcpServer(
  cliPath: string,
  options: {
    env: Record<string, string | undefined>;
  },
): ChildProcessWithoutNullStreams {
  const args: string[] = ['acp', 'serve'];
  return spawn(cliPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

function extractSessionIdFromSessionNewResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const candidate = (result as Record<string, unknown>).sessionId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

function extractTextFromContentBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as any).type;
    if (type === 'content') {
      const content = (block as any).content;
      if (content && typeof content === 'object' && (content as any).type === 'text') {
        const text = (content as any).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('');
}

export class CocoChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'coco';

  private plugin: ClaudianPlugin;
  private ready = true;
  private readyListeners = new Set<(ready: boolean) => void>();

  private acpProc: ChildProcessWithoutNullStreams | null = null;
  private acpTransport: JsonRpcTransport | null = null;
  private clientConfigKey: string | null = null;

  private activeQueue: AsyncQueue<StreamChunk> | null = null;
  private activePromptSessionId: string | null = null;
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
    if (!conversation) {
      this.sessionId = null;
    }
  }

  async reloadMcpServers(): Promise<void> {
    // MVP: coco manages its own tools; Claudian does not inject MCP servers.
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const cocoSettings = getCocoProviderSettings(settings);
    if (!cocoSettings.enabled) {
      this.setReady(false);
      return false;
    }

    const envVars = getRuntimeEnvironmentVariables(settings, 'coco');
    const cliResolver = ProviderWorkspaceRegistry.getCliResolver('coco');
    const cliPath = (
      this.plugin.getResolvedProviderCliPath?.('coco')
      ?? cliResolver?.resolveFromSettings(settings)
      ?? 'coco'
    );

    if (!cliPath.trim()) {
      this.setReady(false);
      return false;
    }

    const nextConfigKey = JSON.stringify({
      cliPath,
      env: envVars,
    });

    const needsRestart = !this.acpProc
      || !this.acpTransport
      || this.clientConfigKey !== nextConfigKey
      || options?.force === true;
    if (needsRestart) {
      this.shutdownAcpProcess();

      if (options?.force === true) {
        // Force cold start: drop any previously persisted sessionId.
        this.sessionId = null;
        this.sessionInvalidated = true;
      }

      const proc = spawnCocoAcpServer(cliPath, { env: envVars });
      this.acpProc = proc;
      this.clientConfigKey = nextConfigKey;
      const transport = new JsonRpcTransport(proc);
      this.acpTransport = transport;
      transport.start();

      transport.onNotification('session/update', (params) => this.handleSessionUpdate(params));

      // initialize: server accepts empty params
      await transport.request('initialize', {}, 60_000);

      // If we restarted the ACP server, any previous sessionId might be invalid.
      // Coco ACP doesn't currently advertise session/load, so we'll lazily recreate on first prompt failure.
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

    let ensured: boolean;
    try {
      ensured = await this.ensureReady({ force: queryOptions?.forceColdStart });
    } catch (err) {
      yield { type: 'error', content: err instanceof Error ? err.message : String(err) };
      yield { type: 'done' };
      return;
    }
    if (!ensured) {
      yield { type: 'error', content: 'Coco provider is disabled. Enable it in settings.' };
      yield { type: 'done' };
      return;
    }

    // Cancel any previous running prompt.
    if (this.activeQueue) {
      this.cancel();
    }

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const cocoSettingsSnapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'coco');
    const cocoProviderSettings = getCocoProviderSettings(settings);
    const transport = this.acpTransport;
    if (!transport) {
      yield { type: 'error', content: 'Coco ACP 运行时未初始化（acpTransport 为空）。请确认 coco 可执行并重试。' };
      yield { type: 'done' };
      return;
    }

    const queue = new AsyncQueue<StreamChunk>();
    this.activeQueue = queue;

    yield { type: 'assistant_message_start' };

    let finished = false;
    let lastOutputAt = Date.now();
    const startedAt = Date.now();
    const noOutputTimeoutSeconds = Math.max(0, Math.floor(cocoProviderSettings.noOutputTimeoutSeconds ?? 300));
    const NO_OUTPUT_TIMEOUT_MS = noOutputTimeoutSeconds * 1000;

    const finishOnce = (handler: () => void) => {
      if (finished) return;
      finished = true;
      handler();
    };

    const finishWithError = (message: string) => {
      finishOnce(() => {
        queue.push({ type: 'error', content: message });
        queue.push({ type: 'done' });
        queue.finish();
      });
    };

    const timeoutTimer = setInterval(() => {
      if (finished || this.canceled) return;
      const now = Date.now();
      if (NO_OUTPUT_TIMEOUT_MS > 0 && now - lastOutputAt >= NO_OUTPUT_TIMEOUT_MS) {
        this.cancel();
        finishWithError(
          `coco acp 长时间无输出（${Math.round(NO_OUTPUT_TIMEOUT_MS / 1000)}s）。已尝试取消当前请求。`
        );
      }
      if (now - startedAt >= 60 * 60_000) {
        this.cancel();
        finishWithError('coco acp 执行超时（60 分钟）。已自动取消。');
      }
    }, 500);

    // Ensure session
    const vaultPath = getVaultPath(this.plugin.app) ?? process.cwd();
    let createdNewSession = false;
    const ensureSession = async (): Promise<string> => {
      if (this.sessionId) return this.sessionId;
      createdNewSession = true;
      const result = await transport.request('session/new', { cwd: vaultPath, mcpServers: [] }, 60_000);
      const sid = extractSessionIdFromSessionNewResult(result);
      if (!sid) throw new Error('ACP session/new 未返回 sessionId');
      this.sessionId = sid;
      this.sessionInvalidated = true; // persist new sessionId
      return sid;
    };

    const modelFromOptions = (
      queryOptions?.model
      ?? (cocoSettingsSnapshot.model as string | undefined)
      ?? settings.model
    ) as string | undefined;
    const model = typeof modelFromOptions === 'string' ? modelFromOptions.trim() : '';
    const modelId = (model && model !== COCO_DEFAULT_MODEL_OPTION) ? model : undefined;

    const runPrompt = async (sessionId: string, allowRetry: boolean): Promise<void> => {
      this.activePromptSessionId = sessionId;
      // If we are creating a brand new session for an existing conversation history,
      // seed the first prompt with a stitched transcript to preserve continuity.
      const stitched = createdNewSession
        ? buildCocoPrompt(turn, conversationHistory)
        : turn.prompt.trim();

      const params: Record<string, unknown> = {
        sessionId,
        prompt: [{ type: 'text', text: stitched }],
      };
      if (modelId) params.modelId = modelId;

      try {
        await transport.request('session/prompt', params, 0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // If session got invalidated (server restart), retry once with a fresh session.
        if (allowRetry && /session/i.test(message) && /not|invalid|unknown|missing/i.test(message)) {
          this.sessionId = null;
          const newSid = await ensureSession();
          await runPrompt(newSid, false);
          return;
        }
        throw err;
      }
    };

    const promptPromise = (async () => {
      try {
        const sid = await ensureSession();
        await runPrompt(sid, true);
        finishOnce(() => {
          queue.push({ type: 'done' });
          queue.finish();
        });
      } catch (err) {
        finishWithError(err instanceof Error ? err.message : String(err));
      }
    })();

    try {
      for await (const chunk of queue) {
        lastOutputAt = Date.now();
        yield chunk;
      }
      await promptPromise;
    } finally {
      clearInterval(timeoutTimer);
      this.activeQueue = null;
      this.activePromptSessionId = null;
      finishOnce(() => queue.finish());
    }
  }

  cancel(): void {
    this.canceled = true;
    const sid = this.activePromptSessionId ?? this.sessionId;
    if (sid && this.acpTransport) {
      try {
        this.acpTransport.notify('session/cancel', { sessionId: sid });
      } catch {
        // ignore
      }
    }
    this.activeQueue?.push({ type: 'notice', content: 'Canceled.' });
    this.activeQueue?.push({ type: 'done' });
    this.activeQueue?.finish();
    // keep sessionId; cancellation should not imply session destruction
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
    this.shutdownAcpProcess();
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
    const updates: Partial<Conversation> = {};

    if (params.sessionInvalidated) {
      updates.sessionId = this.sessionId;
    }

    if (params.sessionInvalidated && !this.sessionId) {
      updates.sessionId = null;
      updates.providerState = undefined;
    }

    return { updates };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private shutdownAcpProcess(): void {
    if (this.acpTransport) {
      this.acpTransport.dispose();
      this.acpTransport = null;
    }
    if (this.acpProc) {
      try {
        this.acpProc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.acpProc = null;
    }
    this.clientConfigKey = null;
  }

  private handleSessionUpdate(params: unknown): void {
    // Route only updates for the currently active session (if known).
    if (!params || typeof params !== 'object') return;
    const sessionId = (params as any).sessionId;
    if (typeof sessionId === 'string' && this.activePromptSessionId && sessionId !== this.activePromptSessionId) {
      return;
    }

    const update = (params as any).update;
    if (!update || typeof update !== 'object') return;

    const updateType = (update as any).sessionUpdate as string | undefined;
    const queue = this.activeQueue;
    if (!queue) return;

    if (updateType === 'agent_message_chunk') {
      const content = (update as any).content;
      const text = content && typeof content === 'object' ? (content as any).text : undefined;
      if (typeof text === 'string' && text) {
        queue.push({ type: 'text', content: text });
      }
      return;
    }

    if (updateType === 'tool_call') {
      const toolCallId = (update as any).toolCallId;
      if (typeof toolCallId !== 'string' || !toolCallId) return;
      const name = (update as any).title ?? (update as any).kind ?? 'tool';
      const rawInput = (update as any).rawInput;
      queue.push({
        type: 'tool_use',
        id: toolCallId,
        name: typeof name === 'string' ? name : 'tool',
        input: rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {},
      });
      return;
    }

    if (updateType === 'tool_call_update') {
      const toolCallId = (update as any).toolCallId;
      if (typeof toolCallId !== 'string' || !toolCallId) return;
      const status = (update as any).status;
      const content = extractTextFromContentBlocks((update as any).content);
      queue.push({
        type: 'tool_result',
        id: toolCallId,
        content: content || '',
        isError: typeof status === 'string' ? status !== 'completed' : false,
      });
    }
  }
}
