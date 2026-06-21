import {describe, expect, it} from 'vitest';
import {
  configuredMcpServers,
  findMcpServer,
  findMcpPreset,
  isTransport,
  MCP_PRESETS,
  normalizeServer,
  presetIds,
  removeMcpServer,
  toggleMcpServer,
  upsertMcpServer,
} from '../../src/config/mcpSettings.js';
import type {HazeMcpServer} from '../../src/config/settings.js';

describe('mcpSettings', () => {
  describe('presets', () => {
    it('includes the context7 preset with an http transport and url', () => {
      expect(MCP_PRESETS.context7).toMatchObject({transport: 'http', url: 'https://mcp.context7.com/mcp'});
    });

    it('resolves presets by id and lists ids', () => {
      expect(findMcpPreset('context7')).toBeDefined();
      expect(findMcpPreset('nope')).toBeUndefined();
      expect(presetIds()).toContain('context7');
    });
  });

  describe('isTransport', () => {
    it('accepts http/sse/stdio and rejects anything else', () => {
      expect(isTransport('http')).toBe(true);
      expect(isTransport('sse')).toBe(true);
      expect(isTransport('stdio')).toBe(true);
      expect(isTransport('ws')).toBe(false);
      expect(isTransport(42)).toBe(false);
    });
  });

  describe('normalizeServer', () => {
    it('normalizes an http server and trims fields', () => {
      const server = normalizeServer({name: '  ctx7  ', transport: 'http', url: '  https://x/mcp  '});
      expect(server).toEqual({name: 'ctx7', transport: 'http', url: 'https://x/mcp'});
    });

    it('preserves an explicit enabled:false flag', () => {
      expect(normalizeServer({name: 'ctx7', transport: 'http', url: 'https://x', enabled: false})?.enabled).toBe(false);
    });

    it('requires a url for http and sse transports', () => {
      expect(normalizeServer({name: 'a', transport: 'http'})).toBeUndefined();
      expect(normalizeServer({name: 'a', transport: 'sse'})).toBeUndefined();
    });

    it('requires a command for stdio transport and dedupes args', () => {
      expect(normalizeServer({name: 'a', transport: 'stdio'})).toBeUndefined();
      const server = normalizeServer({name: 'a', transport: 'stdio', command: 'node', args: ['x.js', 'x.js', ' y ']});
      expect(server).toEqual({name: 'a', transport: 'stdio', command: 'node', args: ['x.js', 'y']});
    });

    it('drops header entries without a name', () => {
      const server = normalizeServer({
        name: 'a',
        transport: 'http',
        url: 'https://x',
        headers: [{name: 'Authorization', value: 'Bearer t'}, {name: '', value: 'x'}, {value: 'z'}],
      });
      expect(server?.headers).toEqual([{name: 'Authorization', value: 'Bearer t'}]);
    });

    it('rejects unknown transports and missing names', () => {
      expect(normalizeServer({name: 'a', transport: 'ws', url: 'https://x'})).toBeUndefined();
      expect(normalizeServer({transport: 'http', url: 'https://x'})).toBeUndefined();
    });
  });

  describe('configuredMcpServers', () => {
    it('filters out invalid servers and returns valid ones', () => {
      const settings = {
        mcpServers: [
          {name: 'ok', transport: 'http', url: 'https://x'},
          {name: 'bad', transport: 'ws'},
        ],
      };
      const servers = configuredMcpServers(settings);
      expect(servers.map(s => s.name)).toEqual(['ok']);
    });

    it('returns an empty array when nothing is configured', () => {
      expect(configuredMcpServers({})).toEqual([]);
    });
  });

  describe('findMcpServer', () => {
    it('finds a server by name', () => {
      const settings = {mcpServers: [{name: 'ctx7', transport: 'http', url: 'https://x'}]};
      expect(findMcpServer(settings, 'ctx7')?.url).toBe('https://x');
      expect(findMcpServer(settings, 'missing')).toBeUndefined();
    });
  });

  describe('upsert / remove / toggle', () => {
    const context7: HazeMcpServer = {name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp'};
    const another: HazeMcpServer = {name: 'other', transport: 'http', url: 'https://y'};

    it('upsert replaces by name', () => {
      const settings = {mcpServers: [context7, another]};
      const result = upsertMcpServer(settings, {...context7, url: 'https://changed'});
      expect(result.find(s => s.name === 'context7')?.url).toBe('https://changed');
      expect(result).toHaveLength(2);
    });

    it('upsert adds when absent', () => {
      const settings = {mcpServers: [context7]};
      const result = upsertMcpServer(settings, another);
      expect(result).toHaveLength(2);
    });

    it('remove drops a server by name', () => {
      const settings = {mcpServers: [context7, another]};
      expect(removeMcpServer(settings, 'context7').map(s => s.name)).toEqual(['other']);
    });

    it('toggle returns undefined for unknown names and updates enabled otherwise', () => {
      const settings = {mcpServers: [context7]};
      expect(toggleMcpServer(settings, 'nope', false)).toBeUndefined();
      const disabled = toggleMcpServer(settings, 'context7', false);
      expect(disabled?.find(s => s.name === 'context7')?.enabled).toBe(false);
    });
  });
});
