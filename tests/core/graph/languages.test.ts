import {describe, expect, it} from 'vitest';
import {extractFile, isGraphSupportedExtension, resolveImportSpecifier, type FileExtraction} from '../../../src/core/graph/extract.js';
import {resolveGraph} from '../../../src/core/graph/buildGraph.js';

async function extractAll(sources: Record<string, string>): Promise<Map<string, FileExtraction>> {
  const extractions = new Map<string, FileExtraction>();
  for (const [file, content] of Object.entries(sources)) {
    extractions.set(file, await extractFile(file, content));
  }
  return extractions;
}

function names(extraction: FileExtraction): string[] {
  return extraction.symbols.map(symbol => `${symbol.kind}:${symbol.name}${symbol.owner ? `@${symbol.owner}` : ''}`);
}

describe('language-agnostic graph support', () => {
  it('recognizes extensions beyond js/ts and still rejects unsupported ones', () => {
    const supported = ['.js', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.kt', '.lua', '.sh'];
    for (const ext of supported) expect(isGraphSupportedExtension(ext), ext).toBe(true);
    const unsupported = ['.md', '.txt', '.json', '.yaml', '.png', '.wasm'];
    for (const ext of unsupported) expect(isGraphSupportedExtension(ext), ext).toBe(false);
  });

  it('still throws a clear error for unsupported extensions', async () => {
    await expect(extractFile('README.md', '# hi')).rejects.toThrow('No graph grammar for .md');
  });

  it('extracts python classes, methods, fields, imports, self-calls, and heritage', async () => {
    const extraction = await extractFile('src/app.py', [
      'import os',
      'from typing import List',
      'from . import sibling',
      'from .pkg import mod as m',
      '',
      'class Greeter(Base):',
      '    attr = 1',
      '    def greet(self, name):',
      '        return helper()',
      '',
      'def helper(): pass',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:Greeter', 'method:greet@Greeter', 'field:attr@Greeter', 'function:helper',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['os', 'typing', '.', '.pkg']);
    expect(extraction.imports.find(entry => entry.specifier === 'typing')?.bindings).toEqual([{importedName: 'List', localName: 'List'}]);
    expect(extraction.imports.find(entry => entry.specifier === '.pkg')?.bindings).toEqual([{importedName: 'mod', localName: 'm'}]);
    expect(extraction.calls).toContainEqual({name: 'helper', line: 9});
    expect(extraction.heritage).toEqual([{name: 'Base', line: 6}]);
    expect(extraction.exports).toEqual(expect.arrayContaining(['Greeter', 'helper']));
  });

  it('extracts go types, methods with receiver owners, imports, and calls', async () => {
    const extraction = await extractFile('main.go', [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\tutil "example.com/m/util"',
      ')',
      '',
      'type Server struct {',
      '\tport int',
      '}',
      '',
      'func (s *Server) Start() {',
      '\thelper()',
      '}',
      '',
      'func helper() {}',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'type:Server', 'field:port@Server', 'method:Start@Server', 'function:helper',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['fmt', 'example.com/m/util']);
    expect(extraction.imports.find(entry => entry.specifier === 'example.com/m/util')?.namespaceImport).toBe('util');
    expect(extraction.calls).toEqual([{name: 'helper', line: 13}]);
    expect(extraction.heritage).toEqual([]);
    expect(extraction.exports).toEqual(['Server']); // capitalized top-level decls only
  });

  it('extracts rust items, pub exports, crate:: imports, self-calls, and impl-trait heritage', async () => {
    const extraction = await extractFile('src/main.rs', [
      'use crate::config::Settings as Cfg;',
      'use super::util::helper;',
      '',
      'pub struct Server {',
      '    port: u16,',
      '}',
      '',
      'impl Server {',
      '    pub fn start(&self) {',
      '        helper();',
      '        self.stop();',
      '    }',
      '    fn stop(&self) {}',
      '}',
      '',
      'impl Clone for Server {}',
      '',
      'fn helper() {}',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'type:Server', 'field:port@Server', 'method:start@Server', 'method:stop@Server', 'function:helper',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['crate::config::Settings as Cfg', 'super::util::helper']);
    expect(extraction.imports[0]?.bindings).toEqual([{importedName: 'Settings', localName: 'Cfg'}]);
    expect(extraction.calls).toContainEqual({name: 'helper', line: 10});
    expect(extraction.calls).toContainEqual({name: 'stop', line: 11, thisCall: true});
    expect(extraction.heritage).toEqual([{name: 'Clone', line: 16}]);
    expect(extraction.exports).toEqual(['Server']);
  });

  it('extracts java types, members, imports, this-calls, and extends/implements', async () => {
    const extraction = await extractFile('App.java', [
      'package com.example;',
      '',
      'import java.util.List;',
      'import com.example.model.User;',
      '',
      'public class App extends Base implements Runnable {',
      '    private int count = 0;',
      '    public void run() {',
      '        helper();',
      '        this.boot();',
      '    }',
      '    void boot() {}',
      '}',
      '',
      'public interface Service { void serve(); }',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:App', 'field:count@App', 'method:run@App', 'method:boot@App', 'type:Service',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['java.util.List', 'com.example.model.User']);
    expect(extraction.imports[0]?.bindings).toEqual([{importedName: 'List', localName: 'List'}]);
    expect(extraction.calls).toContainEqual({name: 'helper', line: 9});
    expect(extraction.calls).toContainEqual({name: 'boot', line: 10, thisCall: true});
    expect(extraction.heritage).toEqual(expect.arrayContaining([{name: 'Base', line: 6}, {name: 'Runnable', line: 6}]));
    expect(extraction.exports).toEqual(expect.arrayContaining(['App', 'run', 'Service']));
  });

  it('extracts c functions, structs, typedefs, quoted and system includes', async () => {
    const extraction = await extractFile('src/main.c', [
      '#include <stdio.h>',
      '#include "util.h"',
      '',
      'struct Point { int x; int y; };',
      'typedef struct Point PointT;',
      '',
      'int helper(int a) { return a; }',
      '',
      'int main(void) {',
      '    printf("hi");',
      '    return helper(1);',
      '}',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'type:Point', 'type:PointT', 'field:x@Point', 'function:helper', 'function:main',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['<stdio.h>', 'util.h']);
    expect(extraction.calls.map(call => call.name)).toEqual(expect.arrayContaining(['printf', 'helper']));
    expect(extraction.exports).toEqual(expect.arrayContaining(['Point', 'helper', 'main']));
  });

  it('extracts cpp classes with base clauses, members, and this-> calls', async () => {
    const extraction = await extractFile('app.cpp', [
      '#include "base.hpp"',
      '',
      'class Derived : public Base {',
      'public:',
      '    int count = 0;',
      '    void run() { helper(); this->stop(); }',
      '    void stop() {}',
      '};',
      '',
      'int helper() { return 1; }',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:Derived', 'field:count@Derived', 'method:run@Derived', 'method:stop@Derived', 'function:helper',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['base.hpp']);
    expect(extraction.heritage).toEqual([{name: 'Base', line: 3}]);
    expect(extraction.calls).toContainEqual({name: 'helper', line: 6});
    expect(extraction.calls).toContainEqual({name: 'stop', line: 6, thisCall: true});
  });

  it('extracts c# classes, base lists, using directives, and this-calls', async () => {
    const extraction = await extractFile('Service.cs', [
      'using System;',
      'using Utils = My.App.Utils;',
      '',
      'namespace App {',
      '    public class Service : Base, IWorker {',
      '        private int count = 0;',
      '        public void Run() {',
      '            Helper.Do();',
      '            this.Stop();',
      '        }',
      '        void Stop() {}',
      '    }',
      '    interface IWorker { void Work(); }',
      '}',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:Service', 'field:count@Service', 'method:Run@Service', 'method:Stop@Service', 'type:IWorker',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['System', 'My.App.Utils']);
    expect(extraction.imports[1]?.bindings).toEqual([{importedName: 'Utils', localName: 'Utils'}]);
    expect(extraction.heritage).toEqual(expect.arrayContaining([{name: 'Base', line: 5}, {name: 'IWorker', line: 5}]));
    expect(extraction.calls).toContainEqual({name: 'Stop', line: 9, thisCall: true});
    expect(extraction.calls.some(call => call.name === 'Do')).toBe(false); // Helper.Do() stays unresolved
    expect(extraction.exports).toEqual(expect.arrayContaining(['Service', 'Run']));
  });

  it('extracts ruby classes, require imports, self-calls, and superclass', async () => {
    const extraction = await extractFile('greeter.rb', [
      "require 'json'",
      "require_relative 'util'",
      '',
      'class Greeter < Base',
      '  def greet(name)',
      '    helper()',
      '    self.other()',
      '  end',
      '',
      '  def other; end',
      'end',
      '',
      'def helper; end',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:Greeter', 'method:greet@Greeter', 'method:other@Greeter', 'function:helper',
    ]));
    expect(extraction.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({specifier: 'json', kind: 'import'}),
      expect.objectContaining({specifier: 'util', kind: 'require'}),
    ]));
    expect(extraction.calls).toContainEqual({name: 'helper', line: 6});
    expect(extraction.calls).toContainEqual({name: 'other', line: 7, thisCall: true});
    expect(extraction.heritage).toEqual([{name: 'Base', line: 4}]);
    expect(extraction.exports).toEqual(expect.arrayContaining(['Greeter', 'helper']));
  });

  it('extracts php classes, use/require imports, $this-calls, and extends/implements', async () => {
    const extraction = await extractFile('Service.php', [
      '<?php',
      'namespace App;',
      'use App\\Models\\User;',
      "require 'vendor/autoload.php';",
      '',
      'class Service extends Base implements Worker {',
      '    private int $count = 0;',
      '    public function run(): void {',
      '        helper();',
      '        $this->stop();',
      '    }',
      '    function stop() {}',
      '}',
      '',
      'function helper() {}',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:Service', 'field:count@Service', 'method:run@Service', 'method:stop@Service', 'function:helper',
    ]));
    expect(extraction.imports.map(entry => entry.specifier)).toEqual(['App\\Models\\User', 'vendor/autoload.php']);
    expect(extraction.imports[1]?.kind).toBe('require');
    expect(extraction.calls).toContainEqual({name: 'helper', line: 9});
    expect(extraction.calls).toContainEqual({name: 'stop', line: 10, thisCall: true});
    expect(extraction.heritage).toEqual(expect.arrayContaining([{name: 'Base', line: 6}, {name: 'Worker', line: 6}]));
    expect(extraction.exports).toEqual(expect.arrayContaining(['Service', 'helper']));
  });

  it('extracts kotlin classes, delegation specifiers, and this-calls', async () => {
    const extraction = await extractFile('Service.kt', [
      'package com.example',
      '',
      'import com.example.Util.helper as h',
      '',
      'class Service : Base(), Worker {',
      '    val count: Int = 0',
      '    fun run() {',
      '        helper()',
      '        this.stop()',
      '    }',
      '    fun stop() {}',
      '}',
      '',
      'fun helper() {}',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining([
      'class:Service', 'field:count@Service', 'method:run@Service', 'method:stop@Service', 'function:helper',
    ]));
    expect(extraction.imports[0]?.specifier).toBe('com.example.Util.helper');
    expect(extraction.imports[0]?.bindings).toEqual([{importedName: 'helper', localName: 'h'}]);
    expect(extraction.calls).toContainEqual({name: 'helper', line: 8});
    expect(extraction.calls).toContainEqual({name: 'stop', line: 9, thisCall: true});
    expect(extraction.heritage).toEqual(expect.arrayContaining([{name: 'Base', line: 5}, {name: 'Worker', line: 5}]));
    expect(extraction.exports).toEqual(expect.arrayContaining(['Service', 'helper']));
  });

  it('extracts lua module functions, requires, and bare calls', async () => {
    const extraction = await extractFile('mod.lua', [
      'local json = require("json")',
      '',
      'local M = {}',
      '',
      'function M.greet(name)',
      '  helper()',
      'end',
      '',
      'local function helper() end',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining(['method:greet@M', 'function:helper']));
    expect(extraction.imports).toEqual([{specifier: 'json', line: 1, kind: 'require', bindings: []}]);
    expect(extraction.calls).toEqual([{name: 'helper', line: 6}]);
    expect(extraction.exports).toEqual(['helper']);
  });

  it('extracts bash functions, source imports, and command calls', async () => {
    const extraction = await extractFile('tool.sh', [
      '#!/bin/bash',
      'source ./lib.sh',
      '',
      'helper() {',
      '  run_thing --flag',
      '}',
      '',
      'run_thing() { :; }',
      'helper',
    ].join('\n'));
    expect(names(extraction)).toEqual(expect.arrayContaining(['function:helper', 'function:run_thing']));
    expect(extraction.imports).toEqual([{specifier: './lib.sh', line: 2, kind: 'require', bindings: []}]);
    expect(extraction.calls.map(call => call.name)).toEqual(expect.arrayContaining(['run_thing', 'helper']));
    expect(extraction.exports).toEqual(expect.arrayContaining(['helper', 'run_thing']));
  });
});

describe('per-language cross-file resolution', () => {
  it('resolves python relative imports and binds cross-file calls as INFERRED', async () => {
    const extractions = await extractAll({
      'pkg/util.py': 'def helper():\n    pass\n',
      'pkg/main.py': 'from .util import helper\n\ndef main():\n    helper()\n',
    });
    const {edges} = resolveGraph(extractions);
    const importEdge = edges.find(edge => edge.source === 'pkg/main.py' && edge.target === 'pkg/util.py');
    expect(importEdge).toMatchObject({relation: 'imports', confidence: 'EXTRACTED'});
    const callEdge = edges.find(edge => edge.target === 'pkg/util.py#helper' && edge.relation === 'calls');
    expect(callEdge).toMatchObject({source: 'pkg/main.py#main', confidence: 'INFERRED'});
  });

  it('resolves python package __init__ via `from . import x`', () => {
    const fileSet = new Set(['pkg/__init__.py', 'pkg/main.py']);
    expect(resolveImportSpecifier('pkg/main.py', '.', fileSet)).toBe('pkg/__init__.py');
    expect(resolveImportSpecifier('pkg/main.py', '.mod', fileSet)).toBeUndefined();
    expect(resolveImportSpecifier('pkg/main.py', '.mod', new Set(['pkg/mod.py']))).toBe('pkg/mod.py');
    expect(resolveImportSpecifier('pkg/sub/main.py', '..util', new Set(['pkg/util.py']))).toBe('pkg/util.py');
    expect(resolveImportSpecifier('pkg/main.py', 'os', new Set(['os.py']))).toBe('os.py'); // absolute from root
  });

  it('resolves quoted C includes relative to the file, then the root; system includes never resolve', async () => {
    const fileSet = new Set(['src/main.c', 'src/util.h', 'inc/common.h']);
    expect(resolveImportSpecifier('src/main.c', 'util.h', fileSet)).toBe('src/util.h');
    expect(resolveImportSpecifier('src/main.c', 'inc/common.h', fileSet)).toBe('inc/common.h');
    expect(resolveImportSpecifier('src/main.c', '<stdio.h>', fileSet)).toBeUndefined();
    const extractions = await extractAll({
      'src/util.h': 'struct Point { int x; };\n',
      'src/main.c': '#include "util.h"\nint main(void) { return 0; }\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges.find(edge => edge.source === 'src/main.c' && edge.target === 'src/util.h')).toMatchObject({relation: 'imports', confidence: 'EXTRACTED'});
  });

  it('resolves rust crate:: use paths against src/', async () => {
    const fileSet = new Set(['src/main.rs', 'src/config.rs']);
    expect(resolveImportSpecifier('src/main.rs', 'crate::config::Settings', fileSet)).toBe('src/config.rs');
    expect(resolveImportSpecifier('src/main.rs', 'crate::config::inner', new Set(['src/config/inner.rs']))).toBe('src/config/inner.rs');
    expect(resolveImportSpecifier('src/main.rs', 'std::collections::HashMap', fileSet)).toBeUndefined();
    const extractions = await extractAll({
      'src/config.rs': 'pub struct Settings {}\n',
      'src/main.rs': 'use crate::config::Settings;\nfn main() {}\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges.find(edge => edge.source === 'src/main.rs' && edge.target === 'src/config.rs')).toMatchObject({relation: 'imports'});
  });

  it('resolves java dotted imports to workspace files and ruby require_relative', async () => {
    const javaSet = new Set(['App.java', 'com/example/model/User.java']);
    expect(resolveImportSpecifier('App.java', 'com.example.model.User', javaSet)).toBe('com/example/model/User.java');
    const rubySet = new Set(['main.rb', 'lib/util.rb']);
    expect(resolveImportSpecifier('main.rb', 'lib/util', rubySet)).toBe('lib/util.rb');
    expect(resolveImportSpecifier('lib/tool.rb', './util', rubySet)).toBe('lib/util.rb');
    const extractions = await extractAll({
      'com/example/model/User.java': 'package com.example.model;\npublic class User {}\n',
      'App.java': 'import com.example.model.User;\nclass App {}\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges.find(edge => edge.source === 'App.java' && edge.target === 'com/example/model/User.java')).toMatchObject({relation: 'imports'});
  });

  it('resolves bash source and lua require against the workspace', () => {
    expect(resolveImportSpecifier('scripts/tool.sh', './lib.sh', new Set(['scripts/lib.sh']))).toBe('scripts/lib.sh');
    expect(resolveImportSpecifier('scripts/tool.sh', '../shared/common.sh', new Set(['shared/common.sh']))).toBe('shared/common.sh');
    expect(resolveImportSpecifier('mod.lua', 'util.helpers', new Set(['util/helpers.lua']))).toBe('util/helpers.lua');
    expect(resolveImportSpecifier('mod.lua', 'util.helpers', new Set(['util/helpers/init.lua']))).toBe('util/helpers/init.lua');
  });

  it('keeps package/namespace imports edge-free in every language', async () => {
    const extractions = await extractAll({
      'main.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("x") }\n',
      'App.java': 'import java.util.List;\nclass App {}\n',
      'Service.cs': 'using System;\nclass Service {}\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges.filter(edge => edge.relation === 'imports')).toHaveLength(0);
  });
});
