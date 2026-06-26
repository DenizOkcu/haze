import {assertRealPathInsideWorkspace, assertWritablePathInsideWorkspace, resolveWorkspacePath} from '../../utils/path.js';
import {assertNotIgnored} from './fileToolShared.js';
import {discoverScopedContext, scopedContextMutationStop, type ToolExecutionContext} from './toolContext.js';

export async function prepareWorkspaceExisting(filePath: string) {
  const absolutePath = resolveWorkspacePath(filePath);
  await assertRealPathInsideWorkspace(absolutePath, filePath);
  return absolutePath;
}

export async function prepareWorkspaceRead(filePath: string, allowIgnored: boolean | undefined) {
  const absolutePath = resolveWorkspacePath(filePath);
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  await assertRealPathInsideWorkspace(absolutePath, filePath);
  return absolutePath;
}

export async function prepareWorkspaceMutation(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const absolutePath = await prepareWorkspaceRead(filePath, allowIgnored);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop};
}

export async function prepareWorkspaceWritePath(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const absolutePath = resolveWorkspacePath(filePath);
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop, assertExistingInsideWorkspace: async () => await assertRealPathInsideWorkspace(absolutePath, filePath), assertWritableInsideWorkspace: async () => await assertWritablePathInsideWorkspace(absolutePath, filePath)};
}
