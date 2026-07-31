import {describe, expect, it} from 'vitest';
import {generateText, isStepCount, type LanguageModel} from 'ai';
import type {LanguageModelV3, LanguageModelV3GenerateResult} from '@ai-sdk/provider';
import {createSubagentTool} from '../../src/core/subagent/subagentRunner.js';

const usage: LanguageModelV3GenerateResult['usage'] = {
  inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0},
  outputTokens: {total: 1, text: 1, reasoning: 0},
};

function model(generate: (call: number) => LanguageModelV3GenerateResult): LanguageModel {
  let calls = 0;
  const value: LanguageModelV3 = {
    specificationVersion: 'v3', provider: 'test', modelId: 'test', supportedUrls: {},
    doGenerate: async () => generate(++calls),
    doStream: async () => { throw new Error('not used'); },
  };
  return value;
}

const result = (content: LanguageModelV3GenerateResult['content'], finish: LanguageModelV3GenerateResult['finishReason']['unified']): LanguageModelV3GenerateResult => ({
  content,
  finishReason: {unified: finish, raw: finish},
  usage,
  warnings: [],
});

describe('installed AI SDK subagent model-output boundary', () => {
  it('executes without per-tool context and puts only the capsule in response messages while callbacks retain raw telemetry', async () => {
    const workerModel = model(() => result([{type: 'text', text: 'private worker answer'}], 'stop'));
    const mainModel = model(call => call === 1
      ? result([{type: 'tool-call', toolCallId: 'sub-1', toolName: 'subagent', input: JSON.stringify({objective: 'inspect', deliverable: 'answer', mode: 'inspect'})}], 'tool-calls')
      : result([{type: 'text', text: 'parent synthesis'}], 'stop'));
    let rawOutput: unknown;

    const generated = await generateText({
      model: mainModel,
      tools: {subagent: createSubagentTool({model: workerModel, contextFiles: []})},
      // Mirrors the real main turn: toolsContext is provided only for built-in
      // Haze file/bash tools, not for the orchestration-only subagent tool.
      messages: [{role: 'user', content: 'delegate'}],
      stopWhen: isStepCount(2),
      onToolExecutionEnd(event) {
        if (event.toolOutput.type === 'tool-result') rawOutput = event.toolOutput.output;
      },
    });

    expect(rawOutput).toMatchObject({capsule: {deliverable: 'private worker answer'}, telemetry: {modelSelector: 'active-model'}});
    const serializedMessages = JSON.stringify(generated.responseMessages);
    expect(serializedMessages).toContain('private worker answer');
    expect(serializedMessages).not.toContain('telemetry');
    expect(serializedMessages).not.toContain('modelSelector');
  });
});
