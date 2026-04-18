import type { ProviderCapabilities } from '../../core/providers/types';

export const COCO_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'coco',
  // ACP runtime is long-lived and session-backed.
  supportsPersistentRuntime: true,
  // MVP does not hydrate/delete Coco transcripts.
  supportsNativeHistory: false,
  supportsPlanMode: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: false,
  supportsInstructionMode: false,
  supportsMcpTools: false,
  supportsTurnSteer: false,
  reasoningControl: 'none',
});
