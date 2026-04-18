import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { CocoCliResolver } from '../runtime/CocoCliResolver';
import { cocoSettingsTabRenderer } from '../ui/CocoSettingsTab';

export interface CocoWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: ProviderCliResolver;
}

export async function createCocoWorkspaceServices(
  _plugin: ClaudianPlugin,
): Promise<CocoWorkspaceServices> {
  return {
    cliResolver: new CocoCliResolver(),
    settingsTabRenderer: cocoSettingsTabRenderer,
  };
}

export const cocoWorkspaceRegistration: ProviderWorkspaceRegistration<CocoWorkspaceServices> = {
  initialize: async ({ plugin }) => createCocoWorkspaceServices(plugin),
};

export function maybeGetCocoWorkspaceServices(): CocoWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('coco') as CocoWorkspaceServices | null;
}

export function getCocoWorkspaceServices(): CocoWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('coco') as CocoWorkspaceServices;
}

