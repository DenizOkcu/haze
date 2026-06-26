import {YES_CONFIRMATION} from './wizardActions.js';

export function commaList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function commandParts(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function isYesConfirmation(value: string): boolean {
  return value.trim().toLowerCase() === YES_CONFIRMATION;
}

export function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
