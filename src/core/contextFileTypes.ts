/**
 * Shape of one loaded `CLAUDE.md`/`AGENTS.md` context file.
 *
 * It lives in `core` so the context budget can account for context files
 * without importing `config`, which loads them (ARCH-02). `config/contextFiles.ts`
 * remains the import site for consumers and re-exports this type.
 */
export interface ContextFile {
  path: string;
  content: string;
  signature?: string;
}
