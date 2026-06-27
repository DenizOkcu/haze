import fs from 'node:fs/promises';
import path from 'node:path';
import type {HazeSettings} from './settings.js';
import {removeByName, upsertByName} from '../utils/collections.js';

export interface HazeLspServer {
  name: string;
  command: string;
  args?: string[];
  extensions?: string[];
  rootPatterns?: string[];
  enabled?: boolean;
}

export const LSP_PRESETS: Record<string, HazeLspServer> = {
  typescript: {
    name: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
  },
  rust: {
    name: 'rust',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    rootPatterns: ['Cargo.toml', '.git'],
  },
  python: {
    name: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py'],
    rootPatterns: ['pyproject.toml', 'setup.py', '.git'],
  },
  go: {
    name: 'go',
    command: 'gopls',
    args: [],
    extensions: ['.go'],
    rootPatterns: ['go.mod', '.git'],
  },
  php: {
    name: 'php',
    command: 'intelephense',
    args: ['--stdio'],
    extensions: ['.php'],
    rootPatterns: ['composer.json', '.git'],
  },
};

function normalizeExtensions(extensions?: string[]) {
  return [...new Set((extensions ?? []).map(ext => ext.trim()).filter(Boolean).map(ext => ext.startsWith('.') ? ext : `.${ext}`))];
}

export function configuredLspServers(settings: HazeSettings): HazeLspServer[] {
  return (settings.lspServers ?? []).map(server => ({
    ...server,
    args: server.args ?? [],
    extensions: normalizeExtensions(server.extensions),
    rootPatterns: server.rootPatterns ?? [],
    enabled: server.enabled !== false,
  }));
}

export function upsertLspServer(settings: HazeSettings, server: HazeLspServer): HazeLspServer[] {
  const normalized: HazeLspServer = {
    ...server,
    args: server.args ?? [],
    extensions: normalizeExtensions(server.extensions),
    rootPatterns: server.rootPatterns ?? [],
    enabled: server.enabled !== false,
  };
  return upsertByName(configuredLspServers(settings), normalized);
}

export function removeLspServer(settings: HazeSettings, name: string): HazeLspServer[] {
  return removeByName(configuredLspServers(settings), name);
}

export function setLspServerEnabled(settings: HazeSettings, name: string, enabled: boolean): HazeLspServer[] {
  return configuredLspServers(settings).map(server => server.name === name ? {...server, enabled} : server);
}

export async function commandExists(command: string) {
  const candidates = command.includes('/') || command.includes('\\')
    ? [command]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const candidate of candidates) {
    for (const ext of extensions) {
      try {
        await fs.access(`${candidate}${ext}`);
        return true;
      } catch {
        // try next candidate
      }
    }
  }
  return false;
}

export async function installedLspServers(settings: HazeSettings): Promise<HazeLspServer[]> {
  const servers = configuredLspServers(settings).filter(server => server.enabled !== false);
  const checks = await Promise.all(servers.map(async server => await commandExists(server.command)));
  return servers.filter((_server, index) => checks[index]);
}

export function lspPreset(name: string): HazeLspServer | undefined {
  const preset = LSP_PRESETS[name];
  return preset ? {...preset, args: [...(preset.args ?? [])], extensions: [...(preset.extensions ?? [])], rootPatterns: [...(preset.rootPatterns ?? [])], enabled: true} : undefined;
}
