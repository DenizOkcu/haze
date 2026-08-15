import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {
  detectCheckoutMismatch,
  formatCapabilities,
  formatMismatchWarning,
  formatVersionVerbose,
  gitHeadCommit,
  GOAL_SUPERVISOR_ARTIFACT,
  readBuildInfo,
  readPackageVersionAt,
  resolveExecutable,
  resolvePackageRoot,
  runtimeCapabilities,
  type RuntimeCapabilities,
} from '../../utils/buildInfo.js';

/**
 * `haze doctor`: runtime provenance and integrity diagnostics. Reports the
 * version/commit actually executing, verifies compiled artifacts and manifest
 * consistency, prints the capability registry, and warns when a nearby source
 * checkout diverges from the running installation. Pure diagnostics — it
 * never switches or repairs anything.
 *
 * Exit code: 1 when the running build itself is broken (missing artifacts,
 * stale manifest); 0 otherwise (a checkout mismatch is a warning, not a
 * failure of the running runtime).
 */
export interface DoctorDeps {
  stdout?: {write(line: string): void};
  runtimeRoot?: string;
  cwd?: string;
}

interface DoctorCheck {
  label: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const runtimeRoot = deps.runtimeRoot ?? resolvePackageRoot();
  const cwd = deps.cwd ?? process.cwd();
  const write = (line = '') => out.write(`${line}\n`);

  const version = runtimeRoot ? readPackageVersionAt(runtimeRoot) : undefined;
  const build = runtimeRoot ? readBuildInfo([join(runtimeRoot, 'dist', 'buildInfo.json')]) : undefined;
  const capabilities: RuntimeCapabilities = runtimeCapabilities(runtimeRoot ?? cwd);
  const headCommit = runtimeRoot ? gitHeadCommit(runtimeRoot) : undefined;

  write(formatVersionVerbose({
    version: build?.version ?? version ?? 'unknown',
    build,
    runtimeRoot,
    executable: resolveExecutable(),
    capabilities,
  }));
  write();

  write('Installation');
  write(`  root: ${runtimeRoot ?? 'unknown'}`);
  write(`  kind: ${headCommit ? 'development checkout (linked or run in place)' : 'installed package (no git metadata)'}`);
  write();

  write('Capabilities');
  for (const [name, enabled] of Object.entries(capabilities)) {
    write(`  ${name}: ${enabled ? 'enabled' : 'disabled'}`);
  }
  write();

  const checks: DoctorCheck[] = [];
  for (const artifact of ['dist/cli/index.js', GOAL_SUPERVISOR_ARTIFACT, 'dist/buildInfo.json']) {
    const present = runtimeRoot ? existsSync(join(runtimeRoot, artifact)) : false;
    checks.push({label: `artifact ${artifact}`, state: present ? 'ok' : 'fail', detail: present ? 'present' : 'missing'});
  }
  if (build && version) {
    checks.push(build.version === version
      ? {label: 'package/build version', state: 'ok', detail: `${version} == ${version}`}
      : {label: 'package/build version', state: 'fail', detail: `package.json ${version} vs dist/buildInfo.json ${build.version} — rebuild with npm run build`});
  } else if (!build) {
    checks.push({label: 'build manifest', state: 'fail', detail: 'dist/buildInfo.json missing or unreadable — rebuild with npm run build'});
  }
  if (headCommit) {
    checks.push(build?.commit && build.commit !== headCommit
      ? {label: 'build commit', state: 'fail', detail: `built from ${build.commit.slice(0, 7)}, checkout HEAD is ${headCommit.slice(0, 7)} — rebuild with npm run build`}
      : {label: 'build commit', state: 'ok', detail: `${(build?.commit ?? headCommit).slice(0, 7)} matches HEAD`});
  } else {
    checks.push({label: 'build commit', state: 'warn', detail: 'no git metadata at the installation root (normal for installed packages)'});
  }

  write('Checks');
  for (const check of checks) {
    const marker = check.state === 'ok' ? 'ok' : check.state === 'warn' ? 'warning' : 'FAIL';
    write(`  [${marker}] ${check.label}: ${check.detail}`);
  }
  write();

  const mismatch = detectCheckoutMismatch({executingRoot: runtimeRoot, cwd});
  if (mismatch) {
    write('Checkout mismatch');
    for (const line of formatMismatchWarning(mismatch).split('\n')) write(`  ${line}`);
    write();
  } else {
    write('Checkout mismatch: none');
    write();
  }

  if (!capabilities.logicalGoalSupervisor) {
    write('Warning: the goal supervisor is unavailable in this runtime; exhausting a');
    write("turn's step/tool budget may pause the goal instead of continuing automatically.");
    write();
  }

  write(`capability summary: ${formatCapabilities(capabilities)}`);
  const failed = checks.some(check => check.state === 'fail');
  return failed ? 1 : 0;
}
