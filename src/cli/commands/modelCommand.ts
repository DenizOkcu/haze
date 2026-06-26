import {activeProvider, configuredProviders, modelSelector, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleModelCommand(value: string, ctx: CommandContext): Promise<CommandResult | undefined> {
  if (value === '/model') {
    ctx.setModelProviderFilter?.(undefined);
    ctx.setMode('model');
    ctx.addSystemMessage('Choose a model. Selecting a model also sets its provider.');
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
    const provider = activeProvider(ctx.settings);
    if (!provider) {
      ctx.addSystemMessage('No provider configured. Run /provider to choose or add a provider before setting a model.');
      return 'handled';
    }
    const nextProvider = provider.models.includes(selector) ? provider : {...provider, models: [...provider.models, selector]};
    await ctx.updateSettings({provider: provider.name, model: selector, providers: upsertProvider(ctx.settings, nextProvider)});
    ctx.addSystemMessage(`Model set to ${selector} on ${provider.name}. Saved to ~/.haze/settings.json.`);
    return 'handled';
  }
  await ctx.updateSettings({provider: resolved.provider.name, model: resolved.model});
  ctx.addSystemMessage(`Model set to ${resolved.model} on ${resolved.provider.name}. Saved to ~/.haze/settings.json.`);
  return 'handled';
}
