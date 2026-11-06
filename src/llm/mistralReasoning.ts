/** Convert the compatible SDK's reasoning history back to Mistral ThinkChunks. */
export function mistralRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  return {...body, messages: body.messages.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const message = value as Record<string, unknown>;
    if (message.role !== 'assistant' || typeof message.reasoning_content !== 'string' || !message.reasoning_content) return value;
    const {reasoning_content, ...rest} = message;
    const content: unknown[] = [{type: 'thinking', thinking: [{type: 'text', text: reasoning_content}]}];
    if (typeof message.content === 'string' && message.content) content.push({type: 'text', text: message.content});
    return {...rest, content};
  })};
}
