import fs from 'fs-extra';
import path from 'node:path';
import {z} from 'zod';
import {HAZE_DIR} from './paths.js';
import {tightenPrivateFile, writePrivateJsonAtomic} from './privateStorage.js';

export interface OAuthProviderAuth {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export type ProviderAuth = OAuthProviderAuth;
export type ProviderAuthStore = Record<string, ProviderAuth>;

export const PROVIDER_AUTH_FILE = path.join(HAZE_DIR, 'auth.json');

const oauthProviderAuthSchema = z.object({
  type: z.literal('oauth'),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().int().nonnegative(),
  accountId: z.string().min(1).optional(),
});

const providerAuthStoreSchema = z.record(z.string().min(1), oauthProviderAuthSchema);

function authReadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to read Haze provider authentication at ${PROVIDER_AUTH_FILE}: ${message}. Sign in again or repair the authentication file, then retry.`);
}

export async function readProviderAuthStore(): Promise<ProviderAuthStore> {
  try {
    if (await fs.pathExists(PROVIDER_AUTH_FILE)) await tightenPrivateFile(PROVIDER_AUTH_FILE);
    const raw = await fs.readJson(PROVIDER_AUTH_FILE);
    return providerAuthStoreSchema.parse(raw) as ProviderAuthStore;
  } catch (error) {
    const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
    if (code === 'ENOENT') return {};
    throw authReadError(error);
  }
}

export async function getProviderAuth(providerName: string): Promise<ProviderAuth | undefined> {
  return (await readProviderAuthStore())[providerName];
}

export async function setProviderAuth(providerName: string, auth: ProviderAuth): Promise<void> {
  const name = providerName.trim();
  if (!name) throw new Error('Provider name is required to save authentication.');
  const next = {...await readProviderAuthStore(), [name]: oauthProviderAuthSchema.parse(auth) as ProviderAuth};
  await writePrivateJsonAtomic(PROVIDER_AUTH_FILE, next);
}

export async function removeProviderAuth(providerName: string): Promise<void> {
  const current = await readProviderAuthStore();
  if (!(providerName in current)) return;
  delete current[providerName];
  await writePrivateJsonAtomic(PROVIDER_AUTH_FILE, current);
}
