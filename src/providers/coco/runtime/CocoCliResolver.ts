import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderCliResolver } from '../../../core/providers/types';
import { getHostnameKey } from '../../../utils/env';
import { getCocoProviderSettings } from '../settings';

export class CocoCliResolver implements ProviderCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  private readonly cachedHostname = getHostnameKey();

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const cocoSettings = getCocoProviderSettings(settings);
    const hostnamePath = (cocoSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const legacyPath = cocoSettings.cliPath.trim();
    const envText = getRuntimeEnvironmentText(settings, 'coco');

    if (
      this.resolvedPath
      && hostnamePath === this.lastHostnamePath
      && legacyPath === this.lastLegacyPath
      && envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = legacyPath;
    this.lastEnvText = envText;

    // MVP: prefer explicit path, otherwise fall back to command name.
    this.resolvedPath = hostnamePath || legacyPath || 'coco';
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}

