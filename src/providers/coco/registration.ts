import type { ProviderRegistration } from '../../core/providers/types';
import { CocoInlineEditService } from './auxiliary/CocoInlineEditService';
import { CocoInstructionRefineService } from './auxiliary/CocoInstructionRefineService';
import { CocoTitleGenerationService } from './auxiliary/CocoTitleGenerationService';
import { COCO_PROVIDER_CAPABILITIES } from './capabilities';
import { cocoSettingsReconciler } from './env/CocoSettingsReconciler';
import { CocoConversationHistoryService } from './history/CocoConversationHistoryService';
import { CocoChatRuntime } from './runtime/CocoChatRuntime';
import { getCocoProviderSettings } from './settings';
import { cocoChatUIConfig } from './ui/CocoChatUIConfig';

const cocoHistoryService = new CocoConversationHistoryService();

const cocoTaskResultInterpreter = {
  hasAsyncLaunchMarker: () => false,
  extractAgentId: () => null,
  extractStructuredResult: () => null,
  resolveTerminalStatus: (_toolUseResult: unknown, fallbackStatus: 'completed' | 'error') => fallbackStatus,
  extractTagValue: () => null,
};

export const cocoProviderRegistration: ProviderRegistration = {
  displayName: 'Coco',
  blankTabOrder: 30,
  isEnabled: (settings) => getCocoProviderSettings(settings).enabled,
  capabilities: COCO_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^COCO_/i, /^TRAECLI_/i, /^ANTHROPIC_/i, /^CLAUDE_/i],
  chatUIConfig: cocoChatUIConfig,
  settingsReconciler: cocoSettingsReconciler,
  createRuntime: ({ plugin }) => new CocoChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new CocoTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new CocoInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new CocoInlineEditService(plugin),
  historyService: cocoHistoryService,
  taskResultInterpreter: cocoTaskResultInterpreter,
};

