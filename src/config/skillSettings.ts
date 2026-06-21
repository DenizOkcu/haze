import type {HazeSettings, HazeSkillSetting} from './settings.js';

/**
 * Normalized skill metadata overrides. The list is override-only: only skills that
 * deviate from the default (enabled) appear here, so it never desyncs from disk.
 */
export function configuredSkillSettings(settings: HazeSettings): HazeSkillSetting[] {
  const result: HazeSkillSetting[] = [];
  for (const entry of settings.skills ?? []) {
    const name = entry.name?.trim();
    if (!name) continue;
    result.push({name, ...(entry.enabled === false ? {enabled: false} : {})});
  }
  return result;
}

/** A skill is enabled unless an explicit override disables it. */
export function isSkillEnabled(settings: HazeSettings, name: string): boolean {
  const entry = configuredSkillSettings(settings).find(item => item.name === name);
  return entry ? entry.enabled !== false : true;
}

/**
 * Toggle a skill. Enabling clears its override (back to default); disabling records
 * `enabled: false`. Returns the next `skills` array for updateSettings.
 */
export function setSkillEnabled(settings: HazeSettings, name: string, enabled: boolean): HazeSkillSetting[] {
  const others = configuredSkillSettings(settings).filter(entry => entry.name !== name);
  return enabled ? others : [...others, {name, enabled: false}];
}

/** Drop a skill's override entry. Called when a skill directory is removed. */
export function removeSkillSetting(settings: HazeSettings, name: string): HazeSkillSetting[] {
  return configuredSkillSettings(settings).filter(entry => entry.name !== name);
}
