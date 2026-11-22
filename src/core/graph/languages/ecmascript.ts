/**
 * ECMAScript profile (JavaScript / TypeScript / TSX share one walker; the TS
 * grammars are supersets of the JS node vocabulary). Also owns the NodeNext /
 * ESM workspace specifier resolution for the JS family.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {lineOf, firstNamed, stringLiteralText} from '../profile.js';

const KIND_BY_NODE_TYPE: Record<string, Definition['kind']> = {
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

function identifierText(node: TreeNode | null | undefined): string | undefined {
  return node && (node.type === 'identifier' || node.type === 'type_identifier') ? node.text : undefined;
}

/** Method/property names arrive as `property_identifier`, declarations as identifier/type_identifier. */
function definitionNameText(node: TreeNode | null | undefined): string | undefined {
  return node && (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') ? node.text : undefined;
}

function propertyName(nameNode: TreeNode): string | undefined {
  if (nameNode.type === 'identifier' || nameNode.type === 'property_identifier') return nameNode.text;
  if (nameNode.type === 'computed_property_name') {
    const inner = nameNode.namedChildren[0];
    return inner?.text || undefined;
  }
  return undefined;
}

/** Best-effort enclosing class name by walking parent links. */
function enclosingClassName(node: TreeNode): string | undefined {
  let current: TreeNode | null = node;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'abstract_class_declaration' || current.type === 'class_expression') {
      const name = identifierText(current.childForFieldName('name'));
      if (name) return name;
    }
    current = current.parent ?? null;
  }
  return undefined;
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

function declaratorValueKind(declarator: TreeNode): 'function' | 'field' | undefined {
  const name = declarator.childForFieldName('name');
  const nameId = name?.id;
  for (const child of declarator.namedChildren) {
    if (child.id === nameId) continue;
    // A type annotation (`const x: SomeType = {...}`) sits between the name
    // and the value; skip it so typed declarators still yield their symbol.
    if (child.type === 'type_annotation') continue;
    if (child.type === 'arrow_function' || child.type === 'function_expression') return 'function';
    if (VALUED_DECLARATOR_TYPES.has(child.type)) return 'field';
    return undefined;
  }
  return undefined;
}

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    const type = node.type;
    const mapped = KIND_BY_NODE_TYPE[type];
    if (mapped) {
      const name = definitionNameText(node.childForFieldName('name'));
      if (name) {
        definitions.push({name, kind: mapped, line: lineOf(node), ...(owner ? {owner} : {})});
      }
    } else if (type === 'public_field_definition' || type === 'field_definition') {
      const name = propertyName(node.childForFieldName('name') ?? node.namedChildren[0] ?? node);
      if (name) definitions.push({name, kind: 'field', line: lineOf(node), owner: owner ?? enclosingClassName(node) ?? undefined});
    } else if (type === 'property_signature') {
      // Interface members are real API surface; anonymous type-literal
      // properties inside expressions are noise and stay out.
      if (node.parent?.type === 'object_type' && node.parent.parent?.type === 'interface_declaration') {
        const name = propertyName(node.childForFieldName('name') ?? node.namedChildren[0] ?? node);
        if (name) definitions.push({name, kind: 'field', line: lineOf(node), owner: owner ?? enclosingClassName(node) ?? undefined});
      }
    } else if (type === 'variable_declarator') {
      const name = identifierText(node.childForFieldName('name'));
      const valueKind = name ? declaratorValueKind(node) : undefined;
      if (name && valueKind) definitions.push({name, kind: valueKind, line: lineOf(node)});
    }
    const childOwner = type === 'class_declaration' || type === 'abstract_class_declaration'
      ? identifierText(node.childForFieldName('name')) ?? owner
      : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  const visit = (node: TreeNode) => {
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      if (source) {
        const entry: FileImport = {specifier: stringLiteralText(source), line: lineOf(source), kind: 'import', bindings: []};
        // The grammar exposes `source` as a field but the clause is a plain named child.
        const clause = firstNamed(node, 'import_clause');
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
              const alias = firstNamed(part, 'identifier');
              if (alias) entry.namespaceImport = alias.text;
            }
          }
        }
        imports.push(entry);
      }
    } else if (node.type === 'export_statement') {
      const source = node.childForFieldName('source');
      if (source) {
        const entry: FileImport = {specifier: stringLiteralText(source), line: lineOf(source), kind: 'export-from', bindings: []};
        const clause = firstNamed(node, 'export_clause');
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

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  const visit = (node: TreeNode) => {
    if (node.type === 'call_expression') {
      const func = node.childForFieldName('function');
      const record = (name: string, thisCall = false) => {
        const key = `${name}:${lineOf(node)}:${thisCall}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push({name, line: lineOf(node), ...(thisCall ? {thisCall: true} : {})});
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

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  const visit = (node: TreeNode) => {
    if (node.type === 'extends_clause') {
      const value = node.childForFieldName('value');
      // `class A extends B` names B as a type_identifier; `extends expr()` stays out.
      const name = value && (value.type === 'identifier' || value.type === 'type_identifier') ? value.text : undefined;
      if (name) heritage.push({name, line: lineOf(node)});
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return heritage;
}

function collectExports(root: TreeNode, localNames: Set<string>): string[] {
  const exportNames = new Set<string>();
  const visit = (node: TreeNode) => {
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
        const target = firstNamed(node, 'identifier');
        if (target) exportNames.add(target.text);
      } else {
        const clause = firstNamed(node, 'export_clause');
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

/** Candidate path resolutions for a relative import specifier (extensionless, ESM `.js`-style rewriting, index files). */
function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // package imports carry no workspace edge
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (fileSet.has(base)) return base;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
  // NodeNext ESM rewrites: `./foo.js` may name foo.ts; strip the emitted
  // extension and try every source extension (including the extensionless file).
  for (const emitted of ['.js', '.mjs', '.cjs', '.jsx']) {
    if (base.endsWith(emitted)) {
      const stem = base.slice(0, -emitted.length);
      if (fileSet.has(stem)) return stem;
      for (const extension of extensions) {
        if (fileSet.has(`${stem}${extension}`)) return `${stem}${extension}`;
      }
    }
  }
  for (const extension of extensions) {
    if (fileSet.has(`${base}${extension}`)) return `${base}${extension}`;
  }
  for (const index of ['/index.ts', '/index.tsx', '/index.js']) {
    if (fileSet.has(`${base}${index}`)) return `${base}${index}`;
  }
  return undefined;
}

export const ecmascriptProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
  resolveSpecifier,
};
