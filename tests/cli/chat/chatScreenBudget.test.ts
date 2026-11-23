import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ARCH-05: the interactive screen component is orchestration glue. These guards
// keep it from drifting back into the single closure the review measured.
const screenPath = path.join(process.cwd(), 'src', 'cli', 'chat', 'ChatScreen.tsx');
const screen = fs.readFileSync(screenPath, 'utf8');
const lineCount = screen.split('\n').length - (screen.endsWith('\n') ? 1 : 0);

describe('ChatScreen hygiene (ARCH-05)', () => {
  it('declares every type through a top-level import, never an inline import() type expression', () => {
    expect(screen).not.toMatch(/import\(\s*['"]/);
  });

  it('stays within the ARCH-05 size criterion (at most 450 lines)', () => {
    expect(lineCount).toBeLessThanOrEqual(450);
  });
});
