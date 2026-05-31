import {pathToFileURL} from 'node:url';
import type {ToolContext} from './types.js';

async function main() {
  const [toolPath, inputJson = '{}', contextJson = '{}'] = process.argv.slice(2);
  if (!toolPath) throw new Error('Missing tool path');
  const mod = await import(`${pathToFileURL(toolPath).href}?t=${Date.now()}`);
  if (typeof mod.execute !== 'function') throw new Error('Tool must export execute(input, context)');
  const input = JSON.parse(inputJson);
  const context = JSON.parse(contextJson) as ToolContext;
  const result = await mod.execute(input, context);
  process.stdout.write(JSON.stringify(result ?? {ok: true}, null, 2));
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ok: false, message: error instanceof Error ? error.message : String(error)}, null, 2));
  process.exit(1);
});
