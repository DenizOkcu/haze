import {createOpenAI} from '@ai-sdk/openai';
import {readSettings} from '../config/settings.js';

export async function model() {
  const settings = await readSettings();
  const baseURL = process.env.OPENAI_BASE_URL ?? settings.baseURL;
  const apiKey = process.env.OPENAI_API_KEY ?? settings.apiKey;
  const name = process.env.HAZE_MODEL ?? settings.model ?? 'x-ai/grok-build-0.1';
  if (!apiKey) return null;
  return createOpenAI({apiKey, baseURL})(name);
}
