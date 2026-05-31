import {createOpenAI} from '@ai-sdk/openai';

export function model() {
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  const name = process.env.HAZE_MODEL ?? 'gpt-4o-mini';
  if (!apiKey) return null;
  return createOpenAI({apiKey, baseURL})(name);
}
