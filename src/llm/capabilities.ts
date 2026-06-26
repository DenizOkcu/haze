import type {ToolSet} from 'ai';
import type {ToolCategory} from './requestContext.js';

export interface LoadedCapability {
  category: ToolCategory;
  tools: ToolSet;
}

export function addCapabilityTools(input: {availableTools: ToolSet; toolCategories: Map<string, ToolCategory>; loaded: LoadedCapability; skipCollisions?: boolean}) {
  const existing = new Set(Object.keys(input.availableTools));
  for (const [name, value] of Object.entries(input.loaded.tools)) {
    if (input.skipCollisions && existing.has(name)) continue;
    input.toolCategories.set(name, input.loaded.category);
    input.availableTools[name] = value;
    existing.add(name);
  }
}
