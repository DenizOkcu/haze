import {describe, expect, it} from 'vitest';
import path from 'node:path';
import {isProtectedSecretPath, secretSearchExcludeGlobs} from '../../src/core/safety/secretPaths.js';

const HOME = path.join(path.sep, 'home', 'tester');

describe('isProtectedSecretPath', () => {
  it.each([
    ['.env', true],
    ['./.env', true],
    ['config/.env', true],
    ['config/.env.production.local', true],
    ['.envrc', true],
    ['.environment.ts', false],
    ['.env.example', false],
    ['.env.sample', false],
    ['.env.template', false],
    ['config/.env.example', false],
    ['package.json', false],
    ['README.md', false],
  ])('classifies workspace-relative %s', (candidate, expected) => {
    expect(isProtectedSecretPath(candidate, HOME)).toBe(expected);
  });

  it.each([
    [`${HOME}/.ssh/id_ed25519`, true],
    [`${HOME}/.ssh/known_hosts`, true],
    [`${HOME}/.ssh/config`, true],
    [`${HOME}/.gnupg/private-keys-v1.d/key.asc`, true],
    [`${HOME}/.aws/credentials`, true],
    [`${HOME}/.config/gcloud/credentials.db`, true],
    [`${HOME}/.netrc`, true],
    [`${HOME}/.git-credentials`, true],
    [`${HOME}/.docker/config.json`, true],
    [`${HOME}/.zsh_history`, true],
    [`${HOME}/.local/share/fish/fish_history`, true],
    [`${HOME}/.zshenv`, false],
    [`${HOME}/.gitconfig`, false],
    [`${HOME}/projects/app/src/index.ts`, false],
  ])('classifies home path %s', (candidate, expected) => {
    expect(isProtectedSecretPath(candidate, HOME)).toBe(expected);
  });

  it.each([
    ['id_rsa', true],
    ['id_ed25519', true],
    ['keys/id_ecdsa', true],
    ['id_ed25519.pub', false],
    ['id_rsa.pub', false],
    ['server.pem', true],
    ['certs/localhost.pem', true],
    ['tls/tls.key', true],
    ['notakey.keyboard', false],
    ['.bash_history', true],
    ['fixtures/.zsh_history', true],
    ['secrets.json', true],
    ['config/secrets.yaml', true],
    ['secrets.example.json', false],
  ])('classifies basename %s anywhere on disk', (candidate, expected) => {
    expect(isProtectedSecretPath(candidate, HOME)).toBe(expected);
  });
});

describe('secretSearchExcludeGlobs', () => {
  it('contains only negated globs — positive globs would whitelist the search', () => {
    for (const glob of secretSearchExcludeGlobs()) {
      expect(glob.startsWith('!')).toBe(true);
    }
  });
});
