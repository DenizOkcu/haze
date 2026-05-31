import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {readYaml, writeYaml} from '../../src/utils/yaml.js';

describe('yaml utils', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  describe('writeYaml', () => {
    it('writes YAML to a file', async () => {
      const file = path.join(tmp, 'test.yaml');
      await writeYaml(file, {name: 'test', version: '1.0'});
      const content = await fs.readFile(file, 'utf8');
      expect(content).toContain('name: test');
      expect(content).toContain('version: "1.0"');
    });

    it('writes nested objects', async () => {
      const file = path.join(tmp, 'nested.yaml');
      await writeYaml(file, {dependencies: {cli: [{name: 'node'}]}});
      const content = await fs.readFile(file, 'utf8');
      expect(content).toContain('dependencies');
      expect(content).toContain('cli');
    });

    it('writes arrays', async () => {
      const file = path.join(tmp, 'array.yaml');
      await writeYaml(file, {items: ['a', 'b', 'c']});
      const content = await fs.readFile(file, 'utf8');
      expect(content).toContain('- a');
      expect(content).toContain('- b');
    });
  });

  describe('readYaml', () => {
    it('reads YAML from a file', async () => {
      const file = path.join(tmp, 'read.yaml');
      await fs.writeFile(file, 'name: my-skill\nversion: "1.0"\n');
      const result = await readYaml<{name: string; version: string}>(file);
      expect(result.name).toBe('my-skill');
      expect(result.version).toBe('1.0');
    });

    it('reads nested YAML', async () => {
      const file = path.join(tmp, 'nested.yaml');
      await fs.writeFile(file, 'tools:\n  - name: run\n    path: tools/run.ts\n');
      const result = await readYaml<{tools: Array<{name: string; path: string}>}>(file);
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]!.name).toBe('run');
    });
  });

  describe('round-trip', () => {
    it('write then read preserves data', async () => {
      const file = path.join(tmp, 'roundtrip.yaml');
      const original = {name: 'skill', version: '2.0', items: [1, 2, 3], nested: {key: 'value'}};
      await writeYaml(file, original);
      const result = await readYaml<typeof original>(file);
      expect(result).toEqual(original);
    });
  });
});
