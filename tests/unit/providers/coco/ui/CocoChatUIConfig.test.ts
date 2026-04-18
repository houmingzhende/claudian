import { updateCocoProviderSettings } from '../../../../../src/providers/coco/settings';
import { COCO_DEFAULT_MODEL_OPTION,cocoChatUIConfig } from '../../../../../src/providers/coco/ui/CocoChatUIConfig';

describe('cocoChatUIConfig', () => {
  it('includes the default option and configured model', () => {
    const settings: Record<string, unknown> = {
      model: '',
      providerConfigs: {},
      sharedEnvironmentVariables: '',
      customContextLimits: {},
      savedProviderModel: {},
    };

    updateCocoProviderSettings(settings, { defaultModel: 'gpt-4o', enabled: true });

    const options = cocoChatUIConfig.getModelOptions(settings);
    expect(options.some(o => o.value === COCO_DEFAULT_MODEL_OPTION)).toBe(true);
    expect(options.some(o => o.value === 'gpt-4o')).toBe(true);
  });
});
