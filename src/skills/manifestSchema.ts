import {z} from 'zod';

const jsonSchema: z.ZodTypeAny = z.lazy(() => z.object({
  type: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), jsonSchema).optional(),
  items: jsonSchema.optional(),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  additionalProperties: z.union([z.boolean(), jsonSchema]).optional()
}).passthrough());

export const skillManifestSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  version: z.string().min(1),
  description: z.string().min(1),
  author: z.string().optional(),
  homepage: z.string().url().optional(),
  dependencies: z.object({
    cli: z.array(z.object({name: z.string(), description: z.string().optional(), required: z.boolean().optional()})).optional(),
    env: z.array(z.object({name: z.string(), description: z.string().optional(), required: z.boolean().optional()})).optional()
  }).optional(),
  tools: z.array(z.object({name: z.string().min(1), description: z.string().min(1), path: z.string().min(1), input: jsonSchema.optional()})).optional(),
  prompts: z.array(z.object({name: z.string().min(1), description: z.string().optional(), path: z.string().min(1)})).optional(),
});
