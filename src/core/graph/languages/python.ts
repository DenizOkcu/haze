/**
 * Python profile (tree-sitter-python). Module-level names are the export
 * surface (no export keyword); relative imports (`from .pkg import x`) and
 * root-relative dotted specifiers resolve against the workspace file set.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, joinRelative} from '../profile.js';

/** True when the assignment sits directly in a class body (skipping expression_statement wrappers). */
function isClassBodyAssignment(node: TreeNode): boolean {
  let parent: TreeNode | null = node.parent ?? null;
  while (parent?.type === 'expression_statement') parent = parent.parent ?? null;
  return parent?.type === 'block' && parent.parent?.type === 'class_definition';
}

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'class', line: lineOf(node)});
    } else if (node.type === 'function_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: owner ? 'method' : 'function', line: lineOf(node), ...(owner ? {owner} : {})});
    } else if (node.type === 'assignment' && owner && isClassBodyAssignment(node)) {
      // Class-level attribute: assignment directly in the class body block.
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') definitions.push({name: left.text, kind: 'field', line: lineOf(node), owner});
    }
    const childOwner = node.type === 'class_definition' ? node.childForFieldName('name')?.text ?? owner : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type === 'import_statement') {
      const name = node.childForFieldName('name');
      if (!name) return;
      const entry: FileImport = {specifier: name.text, line: lineOf(node), kind: 'import', bindings: []};
      if (name.type === 'aliased_import') {
        const target = name.childForFieldName('name');
        const alias = name.childForFieldName('alias');
        if (target) entry.bindings.push({importedName: target.text, localName: alias?.text ?? target.text});
      } else if (name.type === 'dotted_name') {
        entry.bindings.push({importedName: name.text, localName: name.text});
      }
      imports.push(entry);
    } else if (node.type === 'import_from_statement') {
      const module = node.childForFieldName('module_name');
      if (!module) return;
      const entry: FileImport = {specifier: module.text, line: lineOf(node), kind: 'import', bindings: []};
      for (const child of node.namedChildren) {
        if (child.id === module.id) continue; // node wrappers are recreated per access; compare stable ids
        if (child.type === 'dotted_name') {
          entry.bindings.push({importedName: child.text, localName: child.text});
        } else if (child.type === 'aliased_import') {
          const target = child.childForFieldName('name');
          const alias = child.childForFieldName('alias');
          if (target) entry.bindings.push({importedName: target.text, localName: alias?.text ?? target.text});
        } else if (child.type === 'wildcard_import') {
          entry.namespaceImport = '*';
        }
      }
      imports.push(entry);
    }
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'call') return;
    const func = node.childForFieldName('function');
    if (!func) return;
    const record = (name: string, thisCall = false) => {
      const key = `${name}:${lineOf(node)}:${thisCall}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({name, line: lineOf(node), ...(thisCall ? {thisCall: true} : {})});
      }
    };
    if (func.type === 'identifier') {
      record(func.text);
    } else if (func.type === 'attribute') {
      const object = func.childForFieldName('object');
      const attribute = func.childForFieldName('attribute');
      if (object?.text === 'self' && attribute) record(attribute.text, true);
      // Other attribute calls (obj.method()) stay unresolved on purpose.
    }
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (node.type !== 'class_definition') return;
    const superclasses = node.childForFieldName('superclasses');
    for (const arg of superclasses?.namedChildren ?? []) {
      if (arg.type === 'identifier' || arg.type === 'attribute') heritage.push({name: arg.text, line: lineOf(node)});
    }
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  // Python exports everything defined at module level (no owner).
  const names = new Set<string>();
  for (const def of collectDefinitions(root)) {
    if (!def.owner && (def.kind === 'function' || def.kind === 'class')) names.add(def.name);
  }
  return [...names];
}

/** Resolve dotted/relative Python specifiers: `.pkg.mod` walks up from the file, plain `pkg.mod` tries the workspace root. */
function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  const dotMatch = /^(?<dots>\.*)(?:\.?(?<rest>[\w.]*))?$/.exec(specifier);
  if (!dotMatch?.groups) return undefined;
  const dots = dotMatch.groups.dots!.length;
  const rest = (dotMatch.groups.rest ?? '').replace(/\./g, '/');
  const bases: string[] = [];
  if (dots > 0) {
    let base = path.posix.dirname(fromFile);
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    bases.push(base);
  } else {
    bases.push(''); // absolute imports resolve from the workspace root
  }
  for (const base of bases) {
    const target = rest ? joinRelative(base, rest) : joinRelative(base, '__init__');
    for (const candidate of [`${target}.py`, `${target}/__init__.py`]) {
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export const pythonProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
  resolveSpecifier,
};
