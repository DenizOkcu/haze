import {configuredProviders, modelSelector, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleModelCommand(value: string, ctx: CommandContext): Promise<CommandResult | undefined> {
  if (value === '/model') {
    ctx.setModelProviderFilter?.(undefined);
    ctx.setMode('model');
    ctx.addSystemMessage('Choose a model, or select "add models" to fetch a provider\'s model list and pick from it. Selecting a model also sets its provider.');
    return 'handled';
  }
  if (value === '/model list') {
    const providers = configuredProviders(ctx.settings);
    ctx.addSystemMessage(['Configured models:', ...providers.flatMap(provider => provider.models.map(model => `- ${modelSelector(provider, model)} - ${provider.name}`))].join('\n'));
    return 'handled';
  }
  if (!value.startsWith('/model ')) return undefined;

  const selector = value.slice('/model '.length).trim();
  const resolved = resolveModelSelector(ctx.settings, selector);
  if (resolved.status === 'ambiguous') {
    ctx.addSystemMessage(`Model ${resolved.model} exists on multiple providers: ${resolved.providers.map(provider => modelSelector(provider, resolved.model)).join(', ')}`);
    return 'handled';
  }
  if (resolved.status === 'missing') {
    // UX-10: a bare typo must not be silently registered and persisted — only
    // an explicit `provider:model` selector registers a new model.
    const colon = selector.indexOf(':');
    const namedProvider = colon > 0 ? configuredProviders(ctx.settings).find(candidate => candidate.name === selector.slice(0, colon)) : undefined;
    if (!namedProvider || colon === selector.length - 1) {
      ctx.addSystemMessage(`Unknown model "${selector}". Pick one with /model, list all with /model list, or register a new one explicitly as /model provider:model.`);
      return 'handled';
    }
    const model = selector.slice(colon + 1);
    const nextProvider = namedProvider.models.includes(model) ? namedProvider : {...namedProvider, models: [...namedProvider.models, model]};
    await ctx.updateSettings({provider: namedProvider.name, model, providers: upsertProvider(ctx.settings, nextProvider)});
    ctx.addSystemMessage(`Model set to ${model} on ${namedProvider.name}. Saved to ~/.haze/settings.json.`);
    return 'handled';
  }
  await ctx.updateSettings({provider: resolved.provider.name, model: resolved.model});
  ctx.addSystemMessage(`Model set to ${resolved.model} on ${resolved.provider.name}. Saved to ~/.haze/settings.json.`);
  return 'handled';
}
