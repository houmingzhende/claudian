import type { TitleGenerationCallback, TitleGenerationService } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class CocoTitleGenerationService implements TitleGenerationService {
  constructor(_plugin: ClaudianPlugin) {}

  async generateTitle(
    conversationId: string,
    _userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    await callback(conversationId, {
      success: false,
      error: 'Coco title generation is not supported in MVP.',
    });
  }

  cancel(): void {
    // no-op
  }
}

