/**
 * Deterministic per-file AST extraction via tree-sitter WASM. The graph is
 * language-agnostic: `languages/index.ts` maps file extensions to a vendored
 * grammar (under `assets/graph-grammars/`, shipped via package `files`) plus a
 * pure {@link LanguageProfile} that turns that language's AST into the shared
 * {@link FileExtraction} shape. Adding a language = vendor grammar + register
 * profile; this file only manages parsers and dispatches.
 *
 * Extraction is pure: one source file in, one {@link FileExtraction} out, no
 * workspace access — so results are content-hash cacheable. Cross-file
 * resolution (import targets, call/heritage endpoints) deliberately lives in
 * `buildGraph.ts`, which sees the whole corpus; per-language specifier
 * resolution is delegated back to the profile via {@link resolveImportSpecifier}.
 *
 * Bump {@link EXTRACTOR_VERSION} whenever node/edge derivation logic changes;
 * the cache and the persisted graph both key off it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Language, Parser} from 'web-tree-sitter';
import type {Tree} from 'web-tree-sitter';
import {symbolNodeId} from './model.js';
import {LANGUAGE_BY_EXTENSION, LANGUAGES} from './languages/index.js';
import type {FileExtraction, TreeNode} from './profile.js';

export type {CallSite, Definition, ExtractedSymbol, FileExtraction, FileImport, HeritageEntry, ImportedBinding, LanguageProfile, TreeNode} from './profile.js';

export const EXTRACTOR_VERSION = 5;

/** Largest source file parsed; bigger files are reported as skipped instead. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

type TreeSitterTree = Tree;
type TreeSitterParser = Parser;

/** The 0.27.x runtime exposes `Language` as a named export with a static `.load()`.
 * 0.23.x attached it as `Parser.Language` post-init — no longer needed. */
function languageStatic(): {load(input: string): Promise<Language>} {
  return Language;
}

let grammarsDir: string | undefined;

/**
 * Resolve the vendored grammar directory. Compiled output and source agree on
 * depth (`<root>/dist/core/graph` and `<root>/src/core/graph` are both three
 * levels below the package root), so one relative walk covers dev, tests, and
 * the published package.
 */
function resolveGrammarsDir(): string {
  if (grammarsDir) return grammarsDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vendored = path.resolve(here, '../../../assets/graph-grammars');
  grammarsDir = fs.existsSync(path.join(vendored, 'tree-sitter-typescript.wasm'))
    ? vendored
    : path.dirname(require.resolve('web-tree-sitter/tree-sitter.wasm'));
  return grammarsDir;
}

let parserInit: Promise<void> | undefined;
const loadedLanguages = new Map<string, Promise<Language>>();
const parsers = new Map<string, Promise<TreeSitterParser>>();

/** Language id for a file extension (lowercased), or undefined when unsupported. */
export function languageForExtension(extension: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extension];
}

export function isGraphSupportedExtension(extension: string): boolean {
  return extension in LANGUAGE_BY_EXTENSION;
}

async function parserFor(extension: string): Promise<TreeSitterParser> {
  const languageId = LANGUAGE_BY_EXTENSION[extension];
  if (!languageId) throw new Error(`No graph grammar for ${extension}`);
  let parser = parsers.get(extension);
  if (!parser) {
    parser = (async () => {
      parserInit ??= (async () => {
        const dir = resolveGrammarsDir();
        const coreWasm = path.join(dir, 'web-tree-sitter.wasm');
        await Parser.init(fs.existsSync(coreWasm) ? {locateFile: () => coreWasm} : undefined);
      })();
      await parserInit;
      const grammar = LANGUAGES[languageId]!.grammar;
      const wasmPath = path.join(resolveGrammarsDir(), grammar);
      if (!fs.existsSync(wasmPath)) throw new Error(`Grammar ${grammar} is not available at ${wasmPath}`);
      let language = loadedLanguages.get(grammar);
      if (!language) {
        language = languageStatic().load(wasmPath);
        loadedLanguages.set(grammar, language);
      }
      const parserInstance = new Parser();
      parserInstance.setLanguage(await language);
      return parserInstance;
    })();
    parsers.set(extension, parser);
  }
  return parser;
}

/**
 * Resolve a raw import specifier to a workspace-relative file, using the
 * source file's language profile. Returns undefined when the specifier is
 * external (package/namespace/system) or does not name a workspace file —
 * the import is then recorded without a cross-file edge, never guessed.
 */
export function resolveImportSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  const languageId = LANGUAGE_BY_EXTENSION[path.extname(fromFile).toLowerCase()];
  const profile = languageId ? LANGUAGES[languageId]?.profile : undefined;
  return profile?.resolveSpecifier?.(fromFile, specifier, fileSet);
}

/**
 * Extract one file's structure. `file` is the workspace-relative path used for
 * node ids; `content` is the UTF-8 source. Throws on parser/grammar problems;
 * syntax errors inside the source degrade gracefully (tree-sitter keeps
 * parsing; partial results are still honest structure).
 */
export async function extractFile(file: string, content: string): Promise<FileExtraction> {
  const extension = path.extname(file).toLowerCase();
  const languageId = LANGUAGE_BY_EXTENSION[extension];
  if (!languageId) throw new Error(`No graph grammar for ${extension}`);
  const profile = LANGUAGES[languageId]!.profile;
  const parser = await parserFor(extension);
  const treeRaw = parser.parse(content);
  const tree: TreeSitterTree = treeRaw ?? parser.parse('')!;
  try {
    const root: TreeNode = tree.rootNode;
    const definitions = profile.definitions(root);
    const taken = new Set<string>([file]);
    const symbols = definitions.map(def => ({
      id: symbolNodeId(file, def.name, def.line, taken),
      name: def.name,
      kind: def.kind,
      line: def.line,
      ...(def.owner ? {owner: def.owner} : {}),
    }));
    return {
      version: EXTRACTOR_VERSION,
      file,
      symbols,
      imports: profile.imports(root),
      calls: profile.calls(root),
      heritage: profile.heritage(root),
      exports: profile.exports(root, new Set(definitions.map(def => def.name))),
    };
  } finally {
    tree.delete();
  }
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}
