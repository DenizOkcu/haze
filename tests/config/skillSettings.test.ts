import {describe, expect, it} from 'vitest';
import {
  configuredSkillSettings,
  isSkillEnabled,
  removeSkillSetting,
  setSkillEnabled,
} from '../../src/config/skillSettings.js';
import type {HazeSettings} from '../../src/config/settings.js';

describe('skillSettings', () => {
  describe('enabled overrides', () => {
    it('treats skills as enabled by default', () => {
      expect(isSkillEnabled({}, 'anything')).toBe(true);
      expect(isSkillEnabled({skills: [{name: 'other', enabled: false}]} as HazeSettings, 'anything')).toBe(true);
    });

    it('honors an explicit enabled:false override', () => {
      const settings = {skills: [{name: 'review', enabled: false}]} as HazeSettings;
      expect(isSkillEnabled(settings, 'review')).toBe(false);
      expect(isSkillEnabled(settings, 'other')).toBe(true);
    });

    it('configuredSkillSettings drops entries without a name', () => {
      const settings = {skills: [{name: '  ', enabled: false}, {name: 'review', enabled: false}]} as unknown as HazeSettings;
      expect(configuredSkillSettings(settings)).toEqual([{name: 'review', enabled: false}]);
    });
  });

  describe('setSkillEnabled', () => {
    it('records enabled:false only when disabling (override-only index)', () => {
      expect(setSkillEnabled({}, 'review', false)).toEqual([{name: 'review', enabled: false}]);
    });

    it('clears the override when re-enabling', () => {
      const start = {skills: [{name: 'review', enabled: false}]} as HazeSettings;
      expect(setSkillEnabled(start, 'review', true)).toEqual([]);
    });

    it('keeps other overrides untouched', () => {
      const start = {skills: [{name: 'a', enabled: false}, {name: 'b', enabled: false}]} as HazeSettings;
      expect(setSkillEnabled(start, 'a', true)).toEqual([{name: 'b', enabled: false}]);
    });
  });

  describe('removeSkillSetting', () => {
    it('drops the override for a removed skill directory', () => {
      const start = {skills: [{name: 'a', enabled: false}, {name: 'b', enabled: false}]} as HazeSettings;
      expect(removeSkillSetting(start, 'a')).toEqual([{name: 'b', enabled: false}]);
    });
  });
});
