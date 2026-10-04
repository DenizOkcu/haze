import {assertRealPathInsideRoot} from '../utils/path.js';

/**
 * Shared real-path confinement wrapper for skills: resolves `candidate`
 * inside `root` or throws a ready-to-report error message. Collapses the
 * hand-rolled try/catch formatting previously duplicated across the registry,
 * loader, and builder.
 */
export async function confinedResolve(root: string, candidate: string, label: string, rootLabel: string): Promise<string> {
  try {
    return await assertRealPathInsideRoot(root, candidate, label, rootLabel);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), {cause: error});
  }
}
