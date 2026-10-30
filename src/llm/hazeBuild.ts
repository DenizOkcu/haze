import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import type {LanguageModel} from 'ai';
import type {HazeBuildManifest} from '../config/hazeBuild.js';
import {assertCredentialedEndpointSecure} from '../config/endpointSecurity.js';

/** Native vLLM contract; the maintained compatible adapter preserves reasoning both ways. */
export function createHazeBuildModel(input: {baseURL: string; apiKey: string; manifest: HazeBuildManifest; fetchImpl?: typeof fetch}): LanguageModel {
  const fetchImpl = input.fetchImpl ?? fetch;
  const provider = createOpenAICompatible({
    name: 'hazeBuild', baseURL: input.baseURL, apiKey: input.apiKey, includeUsage: true,
    fetch: async (url, init) => {
      assertCredentialedEndpointSecure(String(url), input.apiKey);
      // Credentials and repository prompts stay on the explicitly configured origin.
      return fetchImpl(url, {...init, redirect: 'error'});
    },
    transformRequestBody: (body: Record<string, unknown>) => {
      const effort = body.reasoning_effort;
      const enabled = typeof effort === 'string' ? effort !== 'none' : undefined;
      // The client owns native sampling (the server override is only a fallback
      // for ad-hoc checks) and stays mode-aware: the pinned model recommends
      // 0.6/0.95 for thinking and 0.7/0.8 without it. Unset thinking means the
      // template default (on), so it keeps the thinking samplers.
      const samplers = enabled === false ? {temperature: 0.7, top_p: 0.8} : {temperature: 0.6, top_p: 0.95};
      const transformed: Record<string, unknown> = {...body,
        temperature: body.temperature ?? samplers.temperature,
        top_p: body.top_p ?? samplers.top_p,
        top_k: body.top_k ?? 20, presence_penalty: body.presence_penalty ?? 0,
        repetition_penalty: body.repetition_penalty ?? 1,
        chat_template_kwargs: {preserve_thinking: input.manifest.capabilities.preserveThinking,
          ...(enabled === undefined ? {} : {enable_thinking: enabled})},
      };
      // Qwen supports a binary switch, not distinct OpenAI compute-effort levels.
      delete transformed.reasoning_effort;
      return transformed;
    },
  });
  return provider.chatModel(input.manifest.model);
}
