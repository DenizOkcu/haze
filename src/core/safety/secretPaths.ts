import os from 'node:os';
import path from 'node:path';

/**
 * Hard secret-file protection for the file tools.
 *
 * Secret files — SSH keys, shell history files, `.env` files, and common
 * credential stores — are never readable or writable through the file tools:
 *
 * - File tools enforce `isProtectedSecretPath` in `workspaceFile.ts` for
 *   reads AND mutations; the check wins over the turn-scoped read bless set
 *   and over `allowIgnored`.
 * - `grep` traversal excludes these names via `secretSearchExcludeGlobs`
 *   (appended after any model-supplied glob, since later ripgrep globs take
 *   precedence — an explicit model glob must not re-include secrets).
 * - The `shell` tool is deliberately NOT hard-filtered (by decision): it
 *   executes commands as the user's login shell, and secret avoidance in
 *   shell is instructed through the system prompt (`SECRET_FILE_RULE` in
 *   `llm/systemPrompt.ts`) instead of command-string enforcement.
 *
 * The list is intentionally strict; conventionally non-secret documentation
 * variants (`.env.example`, `.env.sample`, `.env.template`, `id_*.pub`) stay
 * readable through targeted file reads so placeholder/template workflows
 * keep working (they are excluded from grep traversal, which cannot
 * re-include them without whitelisting the whole search).
 */

/** Whole directories under the user's home that tools must never touch. */
const PROTECTED_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.gcloud', '.config/gcloud'];

/** Shell/REPL history basenames, protected anywhere on disk (not only home). */
const SHELL_HISTORY_BASENAMES = [
  '.bash_history', '.zsh_history', '.sh_history', '.ksh_history', '.lesshst',
  '.mysql_history', '.psql_history', '.python_history', '.node_repl_history',
  '.sqlite_history', '.rediscli_history', 'fish_history',
];

/** Exact files under the user's home that tools must never touch. */
const PROTECTED_HOME_FILES = [
  '.netrc', '.npmrc', '.pypirc', '.vault-token', '.git-credentials',
  '.gem/credentials', '.docker/config.json', '.local/share/fish/fish_history',
  ...SHELL_HISTORY_BASENAMES,
];

/** Basenames protected in any directory, workspace included. */
const PROTECTED_BASENAMES = new Set([
  ...SHELL_HISTORY_BASENAMES,
  'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.toml',
]);

/** OpenSSH private-key stems; `<stem>.pub` public keys stay readable. */
const SSH_KEY_STEMS = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

/** Extensions that conventionally carry private-key material. */
const PROTECTED_EXTENSIONS = ['.pem', '.key'];

/** Suffixes after `.env`/`.envrc` that conventionally hold placeholders, not secrets. */
const ENV_DOC_SUFFIXES = new Set(['example', 'sample', 'template']);

const ENV_STEMS = ['.env', '.envrc'];

function isProtectedEnvName(basename: string): boolean {
  for (const stem of ENV_STEMS) {
    if (basename === stem) return true;
    if (basename.startsWith(`${stem}.`)) {
      return !ENV_DOC_SUFFIXES.has(basename.slice(stem.length + 1));
    }
  }
  return false;
}

function isProtectedSshKeyName(basename: string): boolean {
  return SSH_KEY_STEMS.some(stem => basename === stem || (basename.startsWith(`${stem}.`) && basename !== `${stem}.pub`));
}

/**
 * Whether a path points at (or inside) a protected secret file or credential
 * store. Checked against both lexical names and real paths by callers so
 * symlinks cannot rename a secret into reach (`link -> .env`) or a secret
 * name onto other content (`.env -> target`). Pure function; `homeDir` is
 * injectable for tests.
 */
export function isProtectedSecretPath(candidatePath: string, homeDir: string = os.homedir()): boolean {
  if (!candidatePath) return false;
  const absolute = path.resolve(candidatePath);
  const basename = path.basename(absolute).toLowerCase();

  if (PROTECTED_BASENAMES.has(basename)) return true;
  if (isProtectedEnvName(basename)) return true;
  if (isProtectedSshKeyName(basename)) return true;
  if (PROTECTED_EXTENSIONS.some(extension => basename.endsWith(extension))) return true;

  const relativeToHome = path.relative(path.resolve(homeDir), absolute);
  const insideHome = relativeToHome !== '' && !relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome);
  if (insideHome) {
    const segments = relativeToHome.split(path.sep).map(segment => segment.toLowerCase());
    for (let depth = 1; depth <= segments.length; depth++) {
      if (PROTECTED_HOME_DIRS.includes(segments.slice(0, depth).join('/'))) return true;
    }
    if (PROTECTED_HOME_FILES.includes(segments.join('/'))) return true;
  }
  return false;
}

/**
 * Ripgrep exclusion globs for the `grep` tool. Later globs take precedence in
 * ripgrep, so callers must append these AFTER any model-supplied glob — an
 * explicit model glob must not re-include secrets. Exclusions are strictly
 * negated: a positive "re-include" glob would act as a whitelist and narrow
 * the search to only the re-included names. Documentation variants
 * (`.env.example`, `id_*.pub`) therefore stay out of traversal search but
 * remain readable through targeted `readFile` calls.
 */
export function secretSearchExcludeGlobs(): string[] {
  return [
    '!.env', '!.env.*', '!.envrc', '!.envrc.*',
    '!id_rsa*', '!id_dsa*', '!id_ecdsa*', '!id_ed25519*',
    '!*.pem', '!*.key',
    ...[...SHELL_HISTORY_BASENAMES].map(name => `!${name}`),
    '!secrets.json', '!secrets.yaml', '!secrets.yml', '!secrets.toml',
  ];
}
