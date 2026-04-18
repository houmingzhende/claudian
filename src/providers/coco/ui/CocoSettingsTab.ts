import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetCocoWorkspaceServices } from '../app/CocoWorkspaceServices';
import { getCocoProviderSettings, updateCocoProviderSettings } from '../settings';

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('~');
}

export const cocoSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const cocoWorkspace = maybeGetCocoWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const cocoSettings = getCocoProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable Coco provider')
      .setDesc('When enabled, Coco appears in the provider selector for new conversations.')
      .addToggle((toggle) => toggle
        .setValue(cocoSettings.enabled)
        .onChange(async (value) => {
          updateCocoProviderSettings(settingsBag, { enabled: value });
          await context.plugin.saveSettings();
          context.refreshModelSelectors();
        }));

    const cliPathSetting = new Setting(container)
      .setName(`Coco CLI path (${hostnameKey})`)
      .setDesc('Optional absolute path to coco binary, or a command name resolvable from PATH (e.g. "coco").');

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-warning)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (!looksLikePath(trimmed)) return null;

      const expanded = expandHomePath(trimmed);
      if (!fs.existsSync(expanded)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expanded);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.style.display = 'block';
        if (inputEl) inputEl.style.borderColor = 'var(--text-error)';
        return false;
      }
      validationEl.style.display = 'none';
      if (inputEl) inputEl.style.borderColor = '';
      return true;
    };

    const cliPathsByHost = { ...cocoSettings.cliPathsByHost };
    let cliPathInputEl: HTMLInputElement | null = null;

    const persistCliPath = async (value: string): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, cliPathInputEl ?? undefined);
      if (!isValid) return false;

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      updateCocoProviderSettings(settingsBag, { cliPathsByHost: { ...cliPathsByHost } });
      await context.plugin.saveSettings();
      cocoWorkspace?.cliResolver?.reset();
      return true;
    };

    const currentCliValue = cocoSettings.cliPathsByHost[hostnameKey] || '';
    cliPathSetting.addText((text) => {
      text
        .setPlaceholder('coco')
        .setValue(currentCliValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentCliValue, text.inputEl);
    });

    new Setting(container)
      .setName('Default model name')
      .setDesc('Optional: passed to coco via `--config model.name=<name>`. Leave empty to use coco.yaml default.')
      .addText((text) => {
        text
          .setPlaceholder('gpt-4o')
          .setValue(cocoSettings.defaultModel)
          .onChange(async (value) => {
            updateCocoProviderSettings(settingsBag, { defaultModel: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(container)
      .setName('Model options')
      .setDesc('Optional: models shown in the dropdown for Coco. One per line or comma-separated.')
      .addTextArea((text) => {
        text
          .setPlaceholder('gpt-4o\ngpt-4o-mini\n')
          .setValue(cocoSettings.modelOptions)
          .onChange(async (value) => {
            updateCocoProviderSettings(settingsBag, { modelOptions: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          });
        text.inputEl.style.width = '100%';
        text.inputEl.style.minHeight = '80px';
      });

    new Setting(container)
      .setName('No-output timeout (seconds)')
      .setDesc('Abort coco if it produces no stdout/stderr output for this long. Set to 0 to disable.')
      .addText((text) => {
        text
          .setPlaceholder('300')
          .setValue(String(cocoSettings.noOutputTimeoutSeconds ?? 300))
          .onChange(async (value) => {
            updateCocoProviderSettings(settingsBag, { noOutputTimeoutSeconds: value });
            await context.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:coco',
      heading: t('settings.environment') ?? 'Environment',
      name: 'Coco environment variables',
      desc: 'Environment variables scoped to the Coco provider (COCO_*/TRAECLI_*).',
      placeholder: 'COCO_NEXTCODE_URL=...\nTRAECLI_NEXTCODE_URL=...\n',
      renderCustomContextLimits: (limitsContainer) => context.renderCustomContextLimits(limitsContainer, 'coco'),
    });
  },
};
