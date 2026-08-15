import type {HazeSettings, HazeSkillSetting} from './settings.js';
import type {SkillSource} from '../skills/types.js';

/** Normalized override-only skill settings. Legacy entries apply to global skills. */
export function configuredSkillSettings(settings: HazeSettings): HazeSkillSetting[] {
  const result: HazeSkillSetting[] = [];
  for (const entry of settings.skills ?? []) {
    const name = entry.name?.trim();
    if (!name) continue;
    result.push({
      name,
      ...(entry.scope ? {scope: entry.scope} : {}),
      ...(entry.enabled === false ? {enabled: false} : {}),
    });
  }
  return result;
}

function settingScope(entry: HazeSkillSetting): SkillSource {
  return entry.scope ?? 'global';
}

function isSameSkillSetting(entry: HazeSkillSetting, name: string, scope: SkillSource) {
  return entry.name === name && settingScope(entry) === scope;
}

/** A skill is enabled unless an explicit scope-aware override disables it. */
export function isSkillEnabled(settings: HazeSettings, name: string, scope: SkillSource = 'global'): boolean {
  const entry = configuredSkillSettings(settings).find(candidate => isSameSkillSetting(candidate, name, scope));
  return entry ? entry.enabled !== false : true;
}

export function setSkillEnabled(settings: HazeSettings, name: string, enabled: boolean, scope: SkillSource = 'global'): HazeSkillSetting[] {
  const others = configuredSkillSettings(settings).filter(entry => !isSameSkillSetting(entry, name, scope));
  return enabled ? others : [...others, {name, ...(scope === 'project' ? {scope} : {}), enabled: false}];
}

export function removeSkillSetting(settings: HazeSettings, name: string, scope: SkillSource = 'global'): HazeSkillSetting[] {
  return configuredSkillSettings(settings).filter(entry => !isSameSkillSetting(entry, name, scope));
}
