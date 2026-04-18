import type { InlineEditRequest, InlineEditResult, InlineEditService } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class CocoInlineEditService implements InlineEditService {
  constructor(_plugin: ClaudianPlugin) {}

  resetConversation(): void {
    // no-op
  }

  async editText(_request: InlineEditRequest): Promise<InlineEditResult> {
    return {
      success: false,
      error: 'Coco inline edit is not supported in MVP.',
    };
  }

  async continueConversation(_message: string): Promise<InlineEditResult> {
    return {
      success: false,
      error: 'Coco inline edit is not supported in MVP.',
    };
  }

  cancel(): void {
    // no-op
  }
}

