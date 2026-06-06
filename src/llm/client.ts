import {createOpenAI} from '@ai-sdk/openai';
import {readSettings} from '../config/settings.js';
import {activeModel} from '../config/providers.js';

export async function model() {
  const settings = await readSettings();
  const selection = activeModel(settings);
  const baseURL = process.env.OPENAI_BASE_URL ?? selection.provider.url;
  const apiKey = process.env.OPENAI_API_KEY ?? selection.provider.key ?? settings.apiKey ?? 'not-needed';
  const name = process.env.HAZE_MODEL ?? selection.model;
  return createOpenAI({apiKey, baseURL}).chat(name);
}
