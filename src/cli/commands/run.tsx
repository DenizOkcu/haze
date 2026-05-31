import React from 'react';
import {render, Text, Box} from 'ink';
import {Header} from '../../ui/components/Header.js';
import {PlanView} from '../../ui/components/PlanView.js';
import {ErrorView} from '../../ui/components/ErrorView.js';
import {AgentRunner} from '../../agent/AgentRunner.js';
import {theme} from '../../ui/theme.js';

function Result({result}: {result: Awaited<ReturnType<AgentRunner['run']>>}) {
  return <Box flexDirection="column">
    <Header />
    <PlanView plan={result.plan} />
    <Text color={theme.violet} bold>Tool results</Text>
    <Text>{result.toolResults.length ? JSON.stringify(result.toolResults, null, 2) : 'No tools ran.'}</Text>
    <Text color={theme.success} bold>Summary</Text>
    <Text>{result.summary}</Text>
  </Box>;
}

export async function runCommand(request: string) {
  try {
    const result = await new AgentRunner().run(request);
    render(<Result result={result} />);
  } catch (error) {
    render(<ErrorView error={error} />);
    process.exitCode = 1;
  }
}
