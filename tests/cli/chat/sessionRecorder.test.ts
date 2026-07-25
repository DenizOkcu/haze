import {afterEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {createSessionRecorder} from '../../../src/cli/chat/sessionRecorder.js';
import {createSession, readSessionEntries} from '../../../src/core/session/sessionStore.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.remove(dir))); });

describe('session recorder', () => {
  it('preserves invocation order and flushes all queued entries', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-recorder-'));
    dirs.push(tmp);
    const cwd = path.join(tmp, 'workspace');
    await fs.ensureDir(cwd);
    const session = await createSession({cwd, sessionsDir: path.join(tmp, 'sessions')});
    const recorder = createSessionRecorder(() => session);
    recorder.recordUiMessage({role: 'user', text: 'first'});
    recorder.recordNamedEvent('middle', 'second');
    recorder.recordUiMessage({role: 'assistant', text: 'third'});
    await recorder.flush();
    const {entries} = await readSessionEntries(session);
    expect(entries.slice(1).map(entry => entry.type === 'event' ? entry.name : entry.type === 'ui_message' ? entry.text : entry.type)).toEqual(['first', 'middle', 'third']);
  });

  it('makes persistence failure observable at flush', async () => {
    const recorder = createSessionRecorder(() => ({id: 'bad', cwd: process.cwd(), file: process.cwd()}));
    recorder.recordNamedEvent('event', 'value');
    await expect(recorder.flush()).rejects.toThrow();
    expect(recorder.error()).toBeInstanceOf(Error);
  });
});
