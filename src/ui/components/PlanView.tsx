import React from 'react';
import {Box, Text} from 'ink';
import {theme} from '../theme.js';
import type {AgentPlan} from '../../agent/types.js';

export function PlanView({plan}: {plan: AgentPlan}) {
  return <Box flexDirection="column" marginY={1}>
    <Text color={theme.violet} bold>Plan</Text>
    <Text>{plan.summary}</Text>
    {plan.steps.map((step, i) => <Text key={i}>  {i + 1}. {step.description}{step.tool ? <Text color={theme.purple}> [{step.tool}]</Text> : null}</Text>)}
  </Box>;
}
