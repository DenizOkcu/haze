import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {readSettings, type HazeSettings} from '../../config/settings.js';
import {checkForUpdate} from '../../config/updateCheck.js';
import {detectCheckoutMismatch, formatMismatchWarning, runtimeCapabilities} from '../../utils/buildInfo.js';
import {startupContextInfo, startupProviderInfo} from './startupInfo.js';

const execFile = promisify(execFileCallback);

/** Current git branch name for the workspace header, or undefined outside a repo/branch. */
export async function currentBranchName() {
  try {
    const {stdout} = await execFile('git', ['branch', '--show-current'], {cwd: process.cwd()});
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** What the startup sequence loaded from disk, handed to the screen before the slower steps run. */
export interface StartupLoadedState {
  settings: HazeSettings;
  settingsError?: string;
  branchName?: string;
  contextFiles: ContextFile[];
}

export interface StartupSequenceOptions {
  /** CLI version; when set, an update check runs and outdated builds are reported. */
  version?: string;
  /** Receives the loaded settings/branch/context files as soon as they are read. */
  onLoaded: (loaded: StartupLoadedState) => void;
  /** Session init/continue/resume controller from the screen. */
  initializeSession: () => Promise<void>;
  /** Reloads the skill registry (also reports project-skill and error signatures). */
  refreshSkills: () => Promise<unknown>;
  addSystemMessage: (text: string) => void;
}

/**
 * The chat screen's startup sequence, extracted so ChatScreen stays rendering
 * glue: load settings/branch/context files, show the startup banner, initialize
 * the session, load skills, check for updates, and surface runtime diagnostics.
 * Every step degrades to a system message instead of blocking startup.
 */
export async function runStartupSequence(options: StartupSequenceOptions): Promise<void> {
  const [settingsResult, branch, files] = await Promise.all([
    readSettings().then(value => ({value, error: undefined as string | undefined})).catch(error => ({value: {} as HazeSettings, error: error instanceof Error ? error.message : String(error)})),
    currentBranchName().catch(() => undefined),
    readContextFiles().catch(() => [] as ContextFile[]),
  ]);
  options.onLoaded({
    settings: settingsResult.value,
    settingsError: settingsResult.error,
    branchName: branch,
    contextFiles: files,
  });
  const next = settingsResult.value;
  options.addSystemMessage(settingsResult.error ? settingsResult.error : `${startupProviderInfo(next)}\n\n${startupContextInfo(files)}`);
  await options.initializeSession().catch(error => {
    const text = error instanceof Error ? error.message : String(error);
    options.addSystemMessage(`Session disabled: ${text}`);
  });
  await options.refreshSkills().catch(() => undefined);
  if (options.version) {
    const result = await checkForUpdate({currentVersion: options.version, packageName: '@denizokcu/haze'}).catch(() => undefined);
    if (result?.isOutdated) {
      options.addSystemMessage(`A new version of haze is available: ${result.latestVersion} (you have ${options.version}). Update with:  npm i -g @denizokcu/haze`);
    }
  }
  // Runtime/installation diagnostics: never switch runtimes silently, but
  // make a stale binary serving a workspace with a newer checkout unmistakable.
  const mismatch = detectCheckoutMismatch();
  if (mismatch) {
    options.addSystemMessage(formatMismatchWarning(mismatch));
  } else if (!runtimeCapabilities().goalSupervisorAvailable) {
    options.addSystemMessage('Warning: this haze build lacks the goal supervisor module; exhausting a turn step/tool budget may pause the goal instead of continuing automatically. Reinstall or relink haze (npm run dev:link in the checkout).');
  }
}
