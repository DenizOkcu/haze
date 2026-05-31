import {createOpenAI} from '@ai-sdk/openai';
import {readSettingsSync} from '../config/settings.js';

export function model() {
  const settings = readSettingsSync();
  const baseURL = process.env.OPENAI_BASE_URL ?? settings.baseURL;
  const apiKey = process.env.OPENAI_API_KEY ?? settings.apiKey;
  const name = process.env.HAZE_MODEL ?? settings.model ?? 'openai/gpt-4o-mini';
  if (!apiKey) return null;
  return createOpenAI({apiKey, baseURL})(name);
}
