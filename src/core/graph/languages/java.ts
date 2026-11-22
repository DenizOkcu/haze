/**
 * Java profile (tree-sitter-java). Public type/member names are the export
 * surface (covers `import static`); dotted import specifiers resolve against
 * the workspace root as `com/example/Foo` → `com/example/Foo.java`.
 */
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, firstNamed, hasAccessModifier, lastPathSegment} from '../profile.js';

const TYPE_KINDS: Record<string, Definition['kind']> = {
  class_declaration: 'class',
  interface_declaration: 'type',
  enum_declaration: 'type',
  annotation_type_declaration: 'type',
};

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    const kind = TYPE_KINDS[node.type];
    if (kind) {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind, line: lineOf(node)});
    } else if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'method', line: lineOf(node), ...(owner ? {owner} : {})});
    } else if (node.type === 'field_declaration') {
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name')?.text;
        if (name) definitions.push({name, kind: 'field', line: lineOf(node), ...(owner ? {owner} : {})});
      }
    }
    const childOwner = kind ? node.childForFieldName('name')?.text ?? owner : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'import_declaration') return;
    const scoped = firstNamed(node, 'scoped_identifier');
    const wildcard = firstNamed(node, 'wildcard_import') ?? firstNamed(node, 'asterisk');
    const entry: FileImport = {specifier: scoped?.text ?? '*', line: lineOf(node), kind: 'import', bindings: []};
    if (scoped) {
      const leaf = lastPathSegment(scoped.text);
      entry.bindings.push({importedName: leaf, localName: leaf});
    } else if (wildcard) {
      entry.namespaceImport = '*';
    }
    imports.push(entry);
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'method_invocation') return;
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const object = node.childForFieldName('object');
    const key = `${name}:${lineOf(node)}:${object?.type === 'this'}`;
    if (seen.has(key)) return;
    seen.add(key);
    // object.method() on a typed receiver stays unresolved on purpose; this.method() binds to the enclosing class.
    if (object && object.type !== 'this') return;
    calls.push({name, line: lineOf(node), ...(object?.type === 'this' ? {thisCall: true} : {})});
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (node.type !== 'class_declaration' && node.type !== 'interface_declaration') return;
    const superclass = node.childForFieldName('superclass');
    const superName = superclass?.namedChildren[0]?.text;
    if (superName) heritage.push({name: superName, line: lineOf(node)});
    const interfaces = node.childForFieldName('interfaces');
    // super_interfaces wraps a type_list of type_identifier/generic_type entries.
    const collect = (n: TreeNode) => {
      if (n.type === 'type_identifier') heritage.push({name: n.text, line: lineOf(node)});
      else for (const child of n.namedChildren) collect(child);
    };
    if (interfaces) collect(interfaces);
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  const names = new Set<string>();
  walkNamed(root, node => {
    if (TYPE_KINDS[node.type] || node.type === 'method_declaration' || node.type === 'field_declaration') {
      if (!hasAccessModifier(node, 'public')) return;
      const name = node.childForFieldName('name')?.text
        ?? (node.type === 'field_declaration' ? firstNamed(node, 'variable_declarator')?.childForFieldName('name')?.text : undefined);
      if (name) names.add(name);
    }
  });
  return [...names];
}

function resolveSpecifier(_fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (specifier === '*') return undefined;
  const candidate = `${specifier.replace(/\./g, '/')}.java`;
  return fileSet.has(candidate) ? candidate : undefined;
}

export const javaProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
  resolveSpecifier,
};
