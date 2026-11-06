# Wizard Flow Split

## Problem
- **KISS Violation**: `cli/commands/wizardFlow.ts` centralizes all wizard steps, but:
  - Adds indirection for simple flows (e.g., `/themes`).
  - Hard to debug without tests.

## Impact
- Agents must reason about overly generic wizard logic.

## Solution
- Split into per-domain wizards (e.g., `providerWizard.ts`, `themesWizard.ts`).
- Remove centralization in `wizardFlow.ts`.

## Validation
- **Test**: Update `tests/cli/commands.test.ts` to cover per-domain wizards.
- **Manual**: Verify that `/provider` and `/themes` wizards work independently.

## Files to Modify
- `cli/commands/wizardFlow.ts` (split into per-domain wizards)
- `cli/commands/providerWizard.ts` (new file)
- `cli/commands/themesWizard.ts` (new file)
- `tests/cli/commands.test.ts` (update tests)