import {describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';

// FE-16: Ink routes every color through chalk, whose level detection honors
// NO_COLOR and TERM=dumb (monochrome) and COLORTERM/TERM (256/truecolor
// quantization); FORCE_COLOR intentionally wins over NO_COLOR (Node's own
// precedence). chalk caches its level at import, so each case runs in a real
// child process with a clean env instead of re-importing.
const script = `import React from 'react';import {Text} from 'ink';import {render} from 'ink-testing-library';process.stdout.write(JSON.stringify(render(React.createElement(Text,{color:'#ff0000'},'X')).lastFrame()??''));`;

function renderColored(env: Record<string, string>) {
  const clean: Record<string, string | undefined> = {...process.env};
  for (const key of ['NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'TERM']) delete clean[key];
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {...clean, ...env},
    encoding: 'utf8',
    // The child needs the repo's node_modules for ink/chalk resolution.
    cwd: process.cwd(),
  });
  return JSON.parse(out) as string;
}

describe('color capability detection (FE-16)', () => {
  it('strips color when NO_COLOR is set (wins over COLORTERM)', () => {
    expect(renderColored({NO_COLOR: '1', COLORTERM: 'truecolor'})).toBe('X');
  });

  it('strips color on TERM=dumb (wins over COLORTERM)', () => {
    expect(renderColored({TERM: 'dumb', COLORTERM: 'truecolor'})).toBe('X');
  });

  it('emits an SGR sequence when color is forced', () => {
    expect(renderColored({FORCE_COLOR: '1'})).toContain('[');
  });
});
