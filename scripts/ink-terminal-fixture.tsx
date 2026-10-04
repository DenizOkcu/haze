// Synthetic normal-screen fixture: no settings, providers, sessions or home reads.
import React, {useEffect, useState} from 'react';
import {render, Static, Text, Box, useApp, useWindowSize} from 'ink';
import {DynamicFrame} from '../src/cli/chat/DynamicFrame.js';
import {TextInput} from '../src/ui/components/TextInput.js';
import {safeInputDisplay} from '../src/ui/textGeometry.js';

function Fixture() {
  const {exit} = useApp();
  const {columns, rows} = useWindowSize();
  const [history, setHistory] = useState(Array.from({length: 100}, (_, index) => `fixture-history-${index}`));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), 80);
    return () => clearInterval(timer);
  }, []);
  return <Box flexDirection="column">
    <Static items={history}>{text => <Text key={text}>{text}</Text>}</Static>
    <DynamicFrame columns={columns} rows={rows} sections={{
      live: <Text>{Array.from({length: 30}, (_, index) => `stream-${tick}-${index} 界🙂`).join('\n')}</Text>,
      tasks: <Text>Tasks · Ctrl+O\nfixture task one\nfixture task two</Text>,
      queue: <Text>Queued fixture follow-up</Text>,
      debug: <Text>Fixture debug metadata</Text>,
      activity: <Text>Fixture running · Esc cancel · Ctrl+C exit</Text>,
      status: <Text>Ink migration fixture · no real provider/session</Text>,
    }} input={limits => <TextInput {...limits} placeholder="fixture-ready" onInterrupt={() => exit()}
      onSubmit={value => {
        if (value === '/exit') exit();
        else setHistory(previous => [...previous, `submitted:${safeInputDisplay(JSON.stringify(value))}`]);
      }}/>} />
  </Box>;
}
process.stdout.write('fixture-prior-history\n');
const app = render(<Fixture />, {incrementalRendering: true, maxFps: 15, exitOnCtrlC: false,
  kittyKeyboard: {mode: 'auto', flags: ['disambiguateEscapeCodes']}});
try { await app.waitUntilExit(); }
finally { app.cleanup(); }
