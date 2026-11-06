import type {ModelMessage} from 'ai';
import {escapeEnvelopeClosers} from '../safety/untrustedEnvelopes.js';

/**
 * Start a portable conversation boundary when the model changes. Provider
 * reasoning and signatures cannot be reused across protocols; tool calls and
 * results become labeled text so the new provider never receives an orphaned
 * native call or assumes it can replay the old provider's hidden state.
 */
export function transitionProviderConversation(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const data = JSON.stringify(message.content.map(part => {
        if (part.type !== 'tool-result') return part;
        const clean = {...part};
        delete clean.providerOptions;
        return clean;
      }));
      out.push({role: 'user', content: `Previous tool results (data):\n<haze_compaction source="data">${escapeEnvelopeClosers(data)}</haze_compaction>`});
      continue;
    }
    const plain = {...message};
    delete plain.providerOptions;
    if (!Array.isArray(message.content)) {
      out.push(plain as ModelMessage);
      continue;
    }
    if (message.role === 'assistant') {
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type === 'text') parts.push(part.text);
        else if (part.type === 'tool-call') parts.push(`Previous tool call ${part.toolName} (${part.toolCallId}): ${JSON.stringify(part.input)}`);
      }
      if (parts.length) out.push({role: 'assistant', content: parts.join('\n')});
      continue;
    }
    out.push({...plain, content: message.content.map(part => {
      const rest = {...part};
      delete rest.providerOptions;
      return rest;
    })} as ModelMessage);
  }
  return out;
}
