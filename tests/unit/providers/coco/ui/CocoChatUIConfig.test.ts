import { updateCocoProviderSettings } from '../../../../../src/providers/coco/settings';
import { COCO_DEFAULT_MODEL_OPTION, cocoChatUIConfig } from '../../../../../src/providers/coco/ui/CocoChatUIConfig';

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

  it('includes configured model list options and owns them', () => {
    const settings: Record<string, unknown> = {
      model: '',
      providerConfigs: {},
      sharedEnvironmentVariables: '',
      customContextLimits: {},
      savedProviderModel: {},
    };

    updateCocoProviderSettings(settings, {
      enabled: true,
      modelOptions: 'gpt-4o\ngpt-4o-mini, gpt-4o\n',
    });

    const options = cocoChatUIConfig.getModelOptions(settings);
    expect(options.some(o => o.value === 'gpt-4o')).toBe(true);
    expect(options.some(o => o.value === 'gpt-4o-mini')).toBe(true);
    expect(cocoChatUIConfig.ownsModel('gpt-4o', settings)).toBe(true);
    expect(cocoChatUIConfig.ownsModel('gpt-4o-mini', settings)).toBe(true);
  });
});
