/**
 * Language registry: extension → language → vendored grammar WASM + profile.
 * This is the single place to extend graph support: vendor the grammar into
 * `assets/graph-grammars/` (see NOTICE.md), write a `LanguageProfile`, and add
 * one entry here. `extract.ts` and `buildGraph.ts` consume only this table.
 */
import type {LanguageProfile} from '../profile.js';
import {ecmascriptProfile} from './ecmascript.js';
import {pythonProfile} from './python.js';
import {goProfile} from './go.js';
import {rustProfile} from './rust.js';
import {javaProfile} from './java.js';
import {cProfile, cppProfile} from './cfamily.js';
import {csharpProfile} from './csharp.js';
import {rubyProfile} from './ruby.js';
import {phpProfile} from './php.js';
import {kotlinProfile} from './kotlin.js';
import {luaProfile} from './lua.js';
import {bashProfile} from './bash.js';

export interface LanguageSpec {
  /** Grammar WASM file name inside `assets/graph-grammars/`. */
  grammar: string;
  profile: LanguageProfile;
}

export const LANGUAGES: Record<string, LanguageSpec> = {
  javascript: {grammar: 'tree-sitter-javascript.wasm', profile: ecmascriptProfile},
  typescript: {grammar: 'tree-sitter-typescript.wasm', profile: ecmascriptProfile},
  tsx: {grammar: 'tree-sitter-tsx.wasm', profile: ecmascriptProfile},
  python: {grammar: 'tree-sitter-python.wasm', profile: pythonProfile},
  go: {grammar: 'tree-sitter-go.wasm', profile: goProfile},
  rust: {grammar: 'tree-sitter-rust.wasm', profile: rustProfile},
  java: {grammar: 'tree-sitter-java.wasm', profile: javaProfile},
  c: {grammar: 'tree-sitter-c.wasm', profile: cProfile},
  cpp: {grammar: 'tree-sitter-cpp.wasm', profile: cppProfile},
  csharp: {grammar: 'tree-sitter-c_sharp.wasm', profile: csharpProfile},
  ruby: {grammar: 'tree-sitter-ruby.wasm', profile: rubyProfile},
  php: {grammar: 'tree-sitter-php.wasm', profile: phpProfile},
  kotlin: {grammar: 'tree-sitter-kotlin.wasm', profile: kotlinProfile},
  lua: {grammar: 'tree-sitter-lua.wasm', profile: luaProfile},
  bash: {grammar: 'tree-sitter-bash.wasm', profile: bashProfile},
};

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.lua': 'lua',
  '.sh': 'bash',
  '.bash': 'bash',
};

/** All extensions the graph can parse (used by the workspace walk filter). */
export const SUPPORTED_EXTENSIONS: string[] = Object.keys(LANGUAGE_BY_EXTENSION);
