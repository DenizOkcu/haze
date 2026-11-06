import type {ReasoningLevel} from '../core/agent/reasoningPolicy.js';
import {isMistralApi, mistralReasoningLevels} from './mistralReasoning.js';

/** Known effort levels for direct endpoints; gateways retain their own policy. */
export function providerReasoningLevels(url: string, model: string): readonly ReasoningLevel[] | undefined {
  const mistral = mistralReasoningLevels(url, model);
  if (mistral) return mistral;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  if (host === 'api.groq.com') {
    if (/^openai\/gpt-oss-(?:20b|120b)$/i.test(model)) return ['low', 'medium', 'high'];
    if (model.toLowerCase() === 'qwen/qwen3.8-27b') return ['none', 'low', 'medium', 'high'];
  }
  if ((host === 'api.x.ai' || host.endsWith('.api.x.ai')) && /^grok-4\.[67]$/i.test(model)) return ['low', 'medium', 'high', 'xhigh'];
  // The coding subscription and direct API have always-thinking K3 variants;
  // use the shared subset instead of sending unsupported none to workers.
  if ((host === 'api.moonshot.ai' && /^kimi-k3(?:\.1-pro)?$/i.test(model))
    || ((host === 'api.kimi.com' || host === 'api.kimi.ai') && /^k3(?:\.1-pro)?$/i.test(model))) return ['low', 'high', 'max'];
  return undefined;
}

/** The older Kimi coding alias has no portable effort control. */
export function providerOmitsReasoningEffort(url: string, model: string): boolean {
  try { return ['api.kimi.com', 'api.kimi.ai'].includes(new URL(url).hostname.toLowerCase()) && model.toLowerCase() === 'kimi-for-coding'; }
  catch { return false; }
}

export function hasRestrictedReasoningLevels(url: string, model: string): boolean {
  return isMistralApi(url) || providerOmitsReasoningEffort(url, model) || providerReasoningLevels(url, model) !== undefined;
}
