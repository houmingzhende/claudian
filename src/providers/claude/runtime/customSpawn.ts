import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

import { findNodeExecutable } from '../../../utils/env';

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    const { args, cwd, env, signal } = options;

    // Resolve full path to avoid PATH lookup issues in GUI apps
    if (command === 'node') {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (nodeFullPath) {
        command = nodeFullPath;
      }
    }

    // Do not pass `signal` directly to spawn() — Obsidian's Electron runtime
    // uses a different realm for AbortSignal, causing `instanceof EventTarget`
    // checks inside Node's internals to fail. Handle abort manually instead.
    const child = spawn(command, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      // Always pipe stderr so we can surface Claude Code failures in the UI.
      // IMPORTANT: We must also consume stderr data to avoid backpressure.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (signal) {
      if (signal.aborted) {
        child.kill();
      } else {
        signal.addEventListener('abort', () => child.kill(), { once: true });
      }
    }

    // Drain stderr to prevent the child from blocking if it writes a lot.
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', () => {});
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}
