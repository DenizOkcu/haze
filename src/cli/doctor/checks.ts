import fs from 'fs-extra';
import path from 'node:path';
import {rgPath} from '@vscode/ripgrep';
import {HAZE_DIR} from '../../config/paths.js';
import type {HazeSettings} from '../../config/settings.js';
import {activeModel, configuredProviders} from '../../config/providers.js';
import {configuredLspServers, commandExists} from '../../config/lspSettings.js';
import {configuredMcpServers} from '../../config/mcpSettings.js';
import {readContextFiles} from '../../config/contextFiles.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {CheckResult} from './types.js';

const MIN_NODE_MAJOR = 20;
const REACHABILITY_TIMEOUT_MS = 5000;

function result(
  name: string,
  severity: CheckResult['severity'],
  message: string,
  hint?: string,
  fixable?: boolean,
): CheckResult {
  return {name, severity, message, hint, fixable};
}

export async function checkSettingsValid(): Promise<CheckResult> {
  const file = path.join(HAZE_DIR, 'settings.json');
  let raw: string | undefined;
  try {
    await fs.ensureDir(HAZE_DIR);
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return result('settings.json valid', 'ok', 'No settings.json yet; Haze will create one when you run /provider.');
  }
  try {
    JSON.parse(raw);
    return result('settings.json valid', 'ok', 'settings.json parses as JSON.');
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return result(
      'settings.json valid',
      'critical',
      `Malformed settings.json: ${text}`,
      'Fix the JSON syntax or delete ~/.haze/settings.json and reconfigure with /provider.',
      true,
    );
  }
}

export function checkNodeVersion(): CheckResult {
  const match = process.version.match(/^v(\d+)\./);
  const major = match ? Number(match[1]) : 0;
  if (major < MIN_NODE_MAJOR) {
    return result(
      'node version',
      'warning',
      `Node ${process.version} is below the required >=${MIN_NODE_MAJOR}.`,
      'Install Node.js >=20 and rerun Haze.',
    );
  }
  return result('node version', 'ok', `Node ${process.version} satisfies >=${MIN_NODE_MAJOR}.`);
}

export function checkRipgrepAvailable(): CheckResult {
  try {
    if (rgPath && fs.existsSync(rgPath)) {
      return result('ripgrep available', 'ok', `Bundled ripgrep found.`);
    }
  } catch {
    // fall through
  }
  return result(
    'ripgrep available',
    'warning',
    'Bundled ripgrep binary is missing.',
    'Reinstall @denizokcu/haze or ensure `rg` is on PATH.',
  );
}

export async function checkHazeDirWritable(): Promise<CheckResult> {
  try {
    await fs.ensureDir(HAZE_DIR);
    const probe = path.join(HAZE_DIR, '.write-probe');
    await fs.writeFile(probe, '');
    await fs.remove(probe);
    return result('.haze/ writable', 'ok', `${HAZE_DIR} is writable.`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return result(
      '.haze/ writable',
      'warning',
      `Cannot write to ${HAZE_DIR}: ${text}`,
      'Check permissions on ~/.haze or set a writable HAZE_DIR.',
    );
  }
}

export async function checkProvidersConfigured(settings: HazeSettings): Promise<CheckResult> {
  const providers = configuredProviders(settings);
  if (providers.length === 0) {
    return result('provider configured', 'critical', 'No providers configured.', 'Run /provider to add a provider and model.');
  }
  return result(
    'provider configured',
    'ok',
    `${providers.length} provider(s) configured: ${providers.map(p => p.name).join(', ')}.`,
  );
}

export function checkActiveModel(settings: HazeSettings): CheckResult {
  const resolution = activeModel(settings);
  if (!resolution) {
    if (configuredProviders(settings).length === 0) {
      return result(
        'activeModel resolves',
        'critical',
        'activeModel is undefined because no providers are configured.',
        'Run /provider to add a provider with at least one model.',
      );
    }
    return result(
      'activeModel resolves',
      'critical',
      'activeModel is undefined: the active provider has no models.',
      'Use /provider to add models to the active provider.',
    );
  }
  return result('activeModel resolves', 'ok', `Active model: ${resolution.provider.name}:${resolution.model}.`);
}

export async function checkProviderReachable(settings: HazeSettings): Promise<CheckResult> {
  const resolution = activeModel(settings);
  if (!resolution) return result('provider reachable', 'info', 'Skipped: no active provider to reach.');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    const response = await fetch(resolution.provider.url, {method: 'HEAD', signal: controller.signal});
    clearTimeout(timer);
    if (response.ok || response.status < 500) {
      return result('provider reachable', 'ok', `${resolution.provider.url} responded with HTTP ${response.status}.`);
    }
    return result(
      'provider reachable',
      'warning',
      `${resolution.provider.url} returned HTTP ${response.status}.`,
      'Verify the provider URL and API key if chat is not working.',
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return result(
      'provider reachable',
      'warning',
      `Could not reach ${resolution.provider.url}: ${text}`,
      'This is a soft check; transient failures are normal. Verify network and provider settings if chat is not working.',
    );
  }
}

export async function checkSkillsValid(): Promise<CheckResult> {
  try {
    const registry = await loadSkillRegistry();
    return result('skills parse & validate', 'ok', `${registry.skills.size} skill(s) loaded successfully.`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return result(
      'skills parse & validate',
      'info',
      `Skill loading failed: ${text}`,
      'Inspect ~/.haze/skills/*/SKILL.md for invalid YAML or missing frontmatter.',
    );
  }
}

export async function checkContextFiles(): Promise<CheckResult> {
  try {
    const files = await readContextFiles();
    return result('context files load', 'ok', `${files.length} context file(s) loaded.`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return result(
      'context files load',
      'info',
      `Could not load context files: ${text}`,
      'Check permissions and encoding of AGENTS.md / CLAUDE.md files.',
    );
  }
}

export async function checkLspServers(settings: HazeSettings): Promise<CheckResult> {
  const servers = configuredLspServers(settings).filter(s => s.enabled !== false);
  if (servers.length === 0) return result('LSP presets valid', 'ok', 'No LSP servers configured.');
  const missing: string[] = [];
  for (const server of servers) {
    if (!(await commandExists(server.command))) missing.push(server.command);
  }
  if (missing.length > 0) {
    return result(
      'LSP presets valid',
      'info',
      `LSP command(s) not on PATH: ${missing.join(', ')}`,
      'Install the language server or disable it with /lsp.',
    );
  }
  return result('LSP presets valid', 'ok', `${servers.length} LSP server command(s) found.`);
}

export async function checkMcpServers(settings: HazeSettings): Promise<CheckResult> {
  const servers = configuredMcpServers(settings).filter(s => s.enabled !== false);
  if (servers.length === 0) return result('MCP config valid', 'ok', 'No MCP servers configured.');
  const invalid = servers.filter(s => (s.transport === 'stdio' ? !s.command : !s.url));
  if (invalid.length > 0) {
    return result(
      'MCP config valid',
      'info',
      `${invalid.length} MCP server(s) missing required fields.`,
      'Use /mcp to correct transport, URL, or command.',
    );
  }
  return result('MCP config valid', 'ok', `${servers.length} MCP server(s) configured.`);
}
