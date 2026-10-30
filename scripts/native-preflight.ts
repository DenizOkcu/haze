import {mkdir, writeFile} from 'node:fs/promises';
import {modelWithConfig} from '../src/llm/client.js';
const runtime = await modelWithConfig({modelSelector: 'haze.build:haze0.1-coder-flash'});
if (runtime?.config.providerKind !== 'haze-build' || !runtime.config.deployment) throw new Error('Configure haze.build with kind haze-build and choose haze0.1-coder-flash via /provider.');
await mkdir('.eval', {recursive: true});
await writeFile('.eval/native-deployment.json', JSON.stringify({checkedAt: new Date().toISOString(), deployment: runtime.config.deployment}, null, 2), {mode: 0o600});
console.log('Native deployment contract verified; running actual Haze coding evals.');
