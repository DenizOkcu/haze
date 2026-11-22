/**
 * Language-agnostic extraction contract. Every supported language ships one
 * {@link LanguageProfile} that maps its tree-sitter AST onto the shared
 * {@link FileExtraction} shape, so build/query/analysis stay language-neutral:
 * adding a language means vendoring its grammar WASM and registering a profile
 * in `languages/index.ts` — no other graph code changes.
 *
 * Profiles are pure tree walks: one parsed file in, extraction fields out.
 */
import path from 'node:path';
import type {Node} from 'web-tree-sitter';
import type {GraphNodeKind} from './model.js';

export type TreeNode = Node;

export interface Definition {
  name: string;
  kind: GraphNodeKind;
  line: number;
  owner?: string;
}

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
  /** Raw module specifier as written (./foo.js, ../bar, pkg, "header.h"). */
  specifier: string;
  line: number;
  kind: 'import' | 'export-from' | 'require';
  defaultImport?: string;
  namespaceImport?: string;
  bindings: ImportedBinding[];
}

export interface CallSite {
  /** Called identifier, or method name for `this.method()`-style calls. */
  name: string;
  line: number;
  /** True for `this.x()` / `self.x()` calls; resolvable only against the enclosing class. */
  thisCall?: boolean;
}

export interface HeritageEntry {
  /** Superclass/interface/trait name as written. */
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

export interface LanguageProfile {
  /** Symbol definitions: functions, classes, types, methods, fields. */
  definitions(root: TreeNode): Definition[];
  imports(root: TreeNode): FileImport[];
  calls(root: TreeNode): CallSite[];
  heritage(root: TreeNode): HeritageEntry[];
  /** Names importable from this file by other files. */
  exports(root: TreeNode, localNames: Set<string>): string[];
  /**
   * Optional workspace-relative resolution of a raw import specifier to a
   * file present in `fileSet` (workspace-relative paths). Returning undefined
   * records the import but creates no cross-file edge — honest over guessed.
   */
  resolveSpecifier?(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined;
}

// ---------------------------------------------------------------------------
// Shared tree-walk helpers
// ---------------------------------------------------------------------------

/** Depth-first visit over a node and all named descendants. */
export function walkNamed(node: TreeNode, visit: (node: TreeNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walkNamed(child, visit);
}

export function childText(node: TreeNode | null | undefined, field: string): string | undefined {
  return node?.childForFieldName(field)?.text ?? undefined;
}

export function lineOf(node: TreeNode): number {
  return node.startPosition.row + 1;
}

export function firstNamed(node: TreeNode, type: string): TreeNode | undefined {
  return node.namedChildren.find(child => child.type === type);
}

/** Text of a string-ish literal without its quotes (string_content preferred when present). */
export function stringLiteralText(node: TreeNode): string {
  const content = node.namedChildren.find(child => child.type.endsWith('_content'));
  return (content ?? node).text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * True when the node carries the given access/storage modifier directly —
 * covers Java/C# `modifiers` wrappers, Rust `visibility_modifier`, and C
 * `storage_class_specifier`.
 */
export function hasAccessModifier(node: TreeNode, wanted: string): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers' || child.type === 'modifier' || child.type === 'visibility_modifier' || child.type === 'storage_class_specifier' || child.type === 'declaration_specifiers') {
      if (child.text === wanted) return true;
      if (child.children.some(token => token.text === wanted)) return true;
    }
  }
  return false;
}

/** Last segment of a dotted/scoped path (`a.b.C` → `C`, `a::B` → `B`, `A\B` → `B`). */
export function lastPathSegment(specifier: string): string {
  const parts = specifier.split(/[.:\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? specifier;
}

/** Join workspace-relative posix paths and normalize away `./` and `..` segments. */
export function joinRelative(base: string, rel: string): string {
  return path.posix.normalize(base ? `${base}/${rel}` : rel);
}
