import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ARCH-05: `commands/chat.tsx` is orchestration glue. These guards keep the
// file from drifting back into the single closure the review measured.
const chatTsx = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'commands', 'chat.tsx'), 'utf8');

describe('commands/chat.tsx hygiene (ARCH-05)', () => {
  it('declares every type through a top-level import, never an inline import() type expression', () => {
    expect(chatTsx).not.toMatch(/import\(\s*['"]/);
  });
});
