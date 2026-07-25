import type {HazeSettings, HazeMcpServer, HazeProviderSettings} from '../../config/settings.js';
import type {Mode} from './chatModes.js';
import {captureMcpCommand, captureMcpName, captureMcpTransport, captureMcpUrl, captureProviderName, captureProviderUrl} from './wizardPrompts.js';

type SharedWizardEffect =
  | {type: 'message'; text?: string}
  | {type: 'mode'; mode: Mode};

export type ProviderWizardEffect = SharedWizardEffect
  | {type: 'provider-draft'; patch: Partial<HazeProviderSettings>; replace?: boolean}

export type McpWizardEffect = SharedWizardEffect
  | {type: 'mcp-draft'; patch: Partial<HazeMcpServer>}
  | {type: 'finish-mcp-stdio'; draft: Partial<HazeMcpServer>};

export function transitionProviderField(input: {mode: Mode; value: string; settings: HazeSettings}): ProviderWizardEffect[] | undefined {
  if (input.mode === 'providerAddKey') {
    const key = input.value.trim();
    return [
      {type: 'provider-draft', patch: key ? {key} : {}},
      {type: 'mode', mode: 'providerAddModels'},
      {type: 'message', text: 'Comma-separated model names? Example: llama3.1, qwen2.5-coder, gpt-4o'},
    ];
  }
  const result = input.mode === 'providerAddName' ? captureProviderName(input.settings, input.value)
    : input.mode === 'providerAddUrl' ? captureProviderUrl(input.value)
    : undefined;
  if (!result) return undefined;
  if (result.message) return [{type: 'message', text: result.message}];
  const patch = result.draft ?? {};
  return [
    ...(Object.keys(patch).length ? [{type: 'provider-draft' as const, patch, replace: input.mode === 'providerAddName'}] : []),
    ...(result.nextMode ? [{type: 'mode' as const, mode: result.nextMode as Mode}] : []),
    {type: 'message', text: result.systemMessage},
  ];
}

export function transitionMcpField(input: {mode: Mode; value: string; settings: HazeSettings; draft: Partial<HazeMcpServer>}): McpWizardEffect[] | undefined {
  const result = input.mode === 'mcpAddName' ? captureMcpName(input.settings, input.value)
    : input.mode === 'mcpAddTransport' ? captureMcpTransport(input.value)
    : input.mode === 'mcpAddUrl' ? captureMcpUrl(input.value)
    : input.mode === 'mcpAddCommand' ? captureMcpCommand(input.value)
    : undefined;
  if (!result) return undefined;
  if (result.message) return [{type: 'message', text: result.message}];
  const patch = result.draft ?? {};
  const nextDraft = {...input.draft, ...patch};
  if (result.nextMode === 'chat' && input.mode === 'mcpAddCommand') return [{type: 'finish-mcp-stdio', draft: nextDraft}];
  return [
    ...(Object.keys(patch).length ? [{type: 'mcp-draft' as const, patch}] : []),
    ...(result.nextMode ? [{type: 'mode' as const, mode: result.nextMode as Mode}] : []),
    {type: 'message', text: result.systemMessage},
  ];
}
