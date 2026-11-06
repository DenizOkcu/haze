/**
 * Deterministic per-file AST extraction via tree-sitter WASM (core runtime and
 * js/ts/tsx/jsx grammars vendored under `assets/graph-grammars/`).
 *
 * Extraction is pure: one source file in, one {@link FileExtraction} out, no
 * workspace access — so results are content-hash cacheable. Cross-file
 * resolution (import targets, call/heritage endpoints) deliberately lives in
 * `buildGraph.ts`, which sees the whole corpus.
 *
 * Bump {@link EXTRACTOR_VERSION} whenever node/edge derivation logic changes;
 * the cache and the persisted graph both key off it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Parser from 'web-tree-sitter';
import {symbolNodeId, type GraphNodeKind} from './model.js';

export const EXTRACTOR_VERSION = 3;

/** Largest source file parsed; bigger files are reported as skipped instead. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

type TreeSitterLanguage = import('web-tree-sitter').Language;
type TreeSitterNode = import('web-tree-sitter').SyntaxNode;
type TreeSitterTree = import('web-tree-sitter').Tree;
type TreeSitterParser = import('web-tree-sitter');

/** The runtime attaches `Parser.Language` only after `init()`; the 0.23 typings omit that static. */
function languageStatic(): {load(input: string): Promise<TreeSitterLanguage>} {
  const attached = (Parser as unknown as {Language?: {load(input: string): Promise<TreeSitterLanguage>}}).Language;
  if (!attached) throw new Error('tree-sitter runtime not initialized');
  return attached;
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
const loadedLanguages = new Map<string, Promise<TreeSitterLanguage>>();
const parsers = new Map<string, Promise<TreeSitterParser>>();

const GRAMMAR_BY_EXTENSION: Record<string, string> = {
  '.ts': 'tree-sitter-typescript.wasm',
  '.mts': 'tree-sitter-typescript.wasm',
  '.cts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-tsx.wasm',
  '.mjs': 'tree-sitter-javascript.wasm',
  '.cjs': 'tree-sitter-javascript.wasm',
};

export function isGraphSupportedExtension(extension: string): boolean {
  return extension in GRAMMAR_BY_EXTENSION;
}

async function parserFor(extension: string): Promise<TreeSitterParser> {
  if (!(extension in GRAMMAR_BY_EXTENSION)) throw new Error(`No graph grammar for ${extension}`);
  let parser = parsers.get(extension);
  if (!parser) {
    parser = (async () => {
      parserInit ??= (async () => {
        const dir = resolveGrammarsDir();
        const coreWasm = path.join(dir, 'web-tree-sitter.wasm');
        await Parser.init(fs.existsSync(coreWasm) ? {locateFile: () => coreWasm} : undefined);
      })();
      await parserInit;
      const grammar = GRAMMAR_BY_EXTENSION[extension]!;
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

// ---------------------------------------------------------------------------
// Extraction output shape (the cacheable unit)
// ---------------------------------------------------------------------------

export interface ExtractedSymbol {
  id: string;
  name: string;
  kind: GraphNodeKind;
  line: number;
  /** Enclosing class name for methods/fields; absent on top-level symbols. */
  owner?: string;
}

export interface ImportedBinding {
  /** Name exported by the source module. */
  importedName: string;
  /** Local name after aliasing (`as`); equals importedName when not aliased. */
  localName: string;
}

export interface FileImport {
  /** Raw module specifier as written (./foo.js, ../bar, pkg). */
  specifier: string;
  line: number;
  kind: 'import' | 'export-from' | 'require';
  defaultImport?: string;
  namespaceImport?: string;
  bindings: ImportedBinding[];
}

export interface CallSite {
  /** Called identifier, or property name for `this.method()` member calls. */
  name: string;
  line: number;
  /** True for `this.x()` calls; resolvable only against the enclosing class. */
  thisCall?: boolean;
}

export interface HeritageEntry {
  /** Superclass identifier as written. */
  name: string;
  line: number;
}

export interface FileExtraction {
  version: number;
  file: string;
  symbols: ExtractedSymbol[];
  imports: FileImport[];
  calls: CallSite[];
  heritage: HeritageEntry[];
  /** Names exported for other files (declaration name or explicit export list). */
  exports: string[];
}

// ---------------------------------------------------------------------------
// Tree walks
// ---------------------------------------------------------------------------

const KIND_BY_NODE_TYPE: Record<string, GraphNodeKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  method_definition: 'method',
  method_signature: 'method',
  abstract_method_signature: 'method',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'type',
  type_alias_declaration: 'type',
  enum_declaration: 'type',
};

function identifierText(node: TreeSitterNode | null | undefined): string | undefined {
  return node && (node.type === 'identifier' || node.type === 'type_identifier') ? node.text : undefined;
}

/** Method/property names arrive as `property_identifier`, declarations as identifier/type_identifier. */
function definitionNameText(node: TreeSitterNode | null | undefined): string | undefined {
  return node && (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') ? node.text : undefined;
}

function propertyName(nameNode: TreeSitterNode): string | undefined {
  if (nameNode.type === 'identifier' || nameNode.type === 'property_identifier') return nameNode.text;
  if (nameNode.type === 'computed_property_name') {
    const inner = nameNode.namedChildren[0];
    return inner?.text || undefined;
  }
  return undefined;
}

/** Best-effort enclosing class name by walking parent links. */
function enclosingClassName(node: TreeSitterNode): string | undefined {
  let current: TreeSitterNode | null = node;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'abstract_class_declaration' || current.type === 'class_expression') {
      const name = identifierText(current.childForFieldName('name'));
      if (name) return name;
    }
    current = current.parent ?? null;
  }
  return undefined;
}

interface Definition {
  name: string;
  kind: GraphNodeKind;
  line: number;
  owner?: string;
}

/**
 * Declarators whose value is a non-trivial expression become symbols:
 * functions for arrow/function values (callable), fields for object/array/
 * call/new values (`export const hazeTools = {...}` names a real API
 * surface). Primitive literals and plain identifiers stay out.
 *
 * Node wrappers are recreated per access, so the name child is identified by
 * its stable `.id`, never by reference equality.
 */
const VALUED_DECLARATOR_TYPES = new Set(['arrow_function', 'function_expression', 'object', 'array', 'new_expression', 'call_expression']);

function declaratorValueKind(declarator: TreeSitterNode): 'function' | 'field' | undefined {
  const name = declarator.childForFieldName('name');
  const nameId = name?.id;
  for (const child of declarator.namedChildren) {
    if (child.id === nameId) continue;
    if (child.type === 'arrow_function' || child.type === 'function_expression') return 'function';
    if (VALUED_DECLARATOR_TYPES.has(child.type)) return 'field';
    return undefined;
  }
  return undefined;
}

function collectDefinitions(root: TreeSitterNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeSitterNode, owner: string | undefined) => {
    const type = node.type;
    const mapped = KIND_BY_NODE_TYPE[type];
    if (mapped) {
      const name = definitionNameText(node.childForFieldName('name'));
      if (name) {
        definitions.push({name, kind: mapped, line: node.startPosition.row + 1, ...(owner ? {owner} : {})});
      }
    } else if (type === 'public_field_definition' || type === 'field_definition') {
      const name = propertyName(node.childForFieldName('name') ?? node.namedChildren[0] ?? node);
      if (name) definitions.push({name, kind: 'field', line: node.startPosition.row + 1, owner: owner ?? enclosingClassName(node) ?? undefined});
    } else if (type === 'property_signature') {
      // Interface members are real API surface; anonymous type-literal
      // properties inside expressions are noise and stay out.
      if (node.parent?.type === 'object_type' && node.parent.parent?.type === 'interface_declaration') {
        const name = propertyName(node.childForFieldName('name') ?? node.namedChildren[0] ?? node);
        if (name) definitions.push({name, kind: 'field', line: node.startPosition.row + 1, owner: owner ?? enclosingClassName(node) ?? undefined});
      }
    } else if (type === 'variable_declarator') {
      const name = identifierText(node.childForFieldName('name'));
      const valueKind = name ? declaratorValueKind(node) : undefined;
      if (name && valueKind) definitions.push({name, kind: valueKind, line: node.startPosition.row + 1});
    }
    const childOwner = type === 'class_declaration' || type === 'abstract_class_declaration'
      ? identifierText(node.childForFieldName('name')) ?? owner
      : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeSitterNode): FileImport[] {
  const imports: FileImport[] = [];
  const specifierOf = (source: TreeSitterNode) => source.text.replace(/^['"]|['"]$/g, '');
  const visit = (node: TreeSitterNode) => {
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      if (source) {
        const entry: FileImport = {specifier: specifierOf(source), line: source.startPosition.row + 1, kind: 'import', bindings: []};
        // The grammar exposes `source` as a field but the clause is a plain named child.
        const clause = node.namedChildren.find(child => child.type === 'import_clause');
        if (clause) {
          for (const part of clause.namedChildren) {
            if (part.type === 'named_imports') {
              for (const spec of part.namedChildren) {
                if (spec.type !== 'import_specifier') continue;
                const imported = spec.childForFieldName('name');
                const alias = spec.childForFieldName('alias');
                const importedName = imported ? imported.text : '';
                if (importedName) entry.bindings.push({importedName, localName: alias ? alias.text : importedName});
              }
            } else if (part.type === 'identifier') {
              entry.defaultImport = part.text;
            } else if (part.type === 'namespace_import') {
              const alias = part.namedChildren.find(child => child.type === 'identifier');
              if (alias) entry.namespaceImport = alias.text;
            }
          }
        }
        imports.push(entry);
      }
    } else if (node.type === 'export_statement') {
      const source = node.childForFieldName('source');
      if (source) {
        const entry: FileImport = {specifier: specifierOf(source), line: source.startPosition.row + 1, kind: 'export-from', bindings: []};
        const clause = node.namedChildren.find(child => child.type === 'export_clause');
        if (clause) {
          for (const spec of clause.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name');
            const alias = spec.childForFieldName('alias');
            const importedName = name ? name.text : '';
            if (importedName) entry.bindings.push({importedName, localName: alias ? alias.text : importedName});
          }
        }
        imports.push(entry);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return imports;
}

function collectCalls(root: TreeSitterNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  const visit = (node: TreeSitterNode) => {
    if (node.type === 'call_expression') {
      const func = node.childForFieldName('function');
      const record = (name: string, thisCall = false) => {
        const key = `${name}:${node.startPosition.row + 1}:${thisCall}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push({name, line: node.startPosition.row + 1, ...(thisCall ? {thisCall: true} : {})});
        }
      };
      if (func?.type === 'identifier') {
        record(func.text);
      } else if (func?.type === 'member_expression') {
        const object = func.childForFieldName('object');
        const property = func.childForFieldName('property');
        if (object?.type === 'this' && property?.type === 'property_identifier') {
          record(property.text, true);
        }
        // Other member calls (obj.method()) stay unresolved on purpose:
        // binding receivers to types from AST alone is guesswork, and a wrong
        // calls edge costs more than a missing one.
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return calls;
}

function collectHeritage(root: TreeSitterNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  const visit = (node: TreeSitterNode) => {
    if (node.type === 'extends_clause') {
      const value = node.childForFieldName('value');
      // `class A extends B` names B as a type_identifier; `extends expr()` stays out.
      const name = value && (value.type === 'identifier' || value.type === 'type_identifier') ? value.text : undefined;
      if (name) heritage.push({name, line: node.startPosition.row + 1});
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return heritage;
}

function collectExports(root: TreeSitterNode, localNames: Set<string>): string[] {
  const exportNames = new Set<string>();
  const visit = (node: TreeSitterNode) => {
    if (node.type === 'export_statement') {
      const declaration = node.childForFieldName('declaration');
      const isDefault = node.text.startsWith('export default');
      if (declaration) {
        const nameNode = declaration.childForFieldName('name') ?? declaration.namedChildren[0];
        const name = identifierText(nameNode) ?? (nameNode ? propertyName(nameNode) : undefined);
        if (name) exportNames.add(name);
        if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
          for (const declarator of declaration.namedChildren) {
            const declaratorName = identifierText(declarator.childForFieldName('name'));
            if (declaratorName) exportNames.add(declaratorName);
          }
        }
      } else if (isDefault) {
        const target = node.namedChildren.find(child => child.type === 'identifier');
        if (target) exportNames.add(target.text);
      } else {
        const clause = node.namedChildren.find(child => child.type === 'export_clause');
        if (clause) {
          for (const spec of clause.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const original = spec.childForFieldName('name');
            // `export { a as default }` also satisfies a default import of a.
            if (original && localNames.has(original.text)) exportNames.add(original.text);
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return [...exportNames];
}

/**
 * Extract one file's structure. `file` is the workspace-relative path used for
 * node ids; `content` is the UTF-8 source. Throws on parser/grammar problems;
 * syntax errors inside the source degrade gracefully (tree-sitter keeps
 * parsing; partial results are still honest structure).
 */
export async function extractFile(file: string, content: string): Promise<FileExtraction> {
  const extension = path.extname(file).toLowerCase();
  const parser = await parserFor(extension);
  const tree: TreeSitterTree = parser.parse(content);
  try {
    const root = tree.rootNode;
    const definitions = collectDefinitions(root);
    const taken = new Set<string>([file]);
    const symbols: ExtractedSymbol[] = definitions.map(def => ({
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
      imports: collectImports(root),
      calls: collectCalls(root),
      heritage: collectHeritage(root),
      exports: collectExports(root, new Set(definitions.map(def => def.name))),
    };
  } finally {
    tree.delete();
  }
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}
