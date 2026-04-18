import type { InstructionRefineService, RefineProgressCallback } from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';

export class CocoInstructionRefineService implements InstructionRefineService {
  constructor(_plugin: ClaudianPlugin) {}

  resetConversation(): void {
    // no-op
  }

  async refineInstruction(
    _rawInstruction: string,
    _existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    const result: InstructionRefineResult = {
      success: false,
      error: 'Coco instruction refinement is not supported in MVP.',
    };
    onProgress?.(result);
    return result;
  }

  async continueConversation(
    _message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    const result: InstructionRefineResult = {
      success: false,
      error: 'Coco instruction refinement is not supported in MVP.',
    };
    onProgress?.(result);
    return result;
  }

  cancel(): void {
    // no-op
  }
}

