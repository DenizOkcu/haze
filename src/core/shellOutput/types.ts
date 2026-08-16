import type {ShellClassification} from '../safety/shellClassifier.js';
import type {ValidationSummary} from '../../llm/toolResultTypes.js';
import type {ReductionContentKind, ReductionParseTier} from '../toolOutput/reduction.js';

type ParseTier = ReductionParseTier;

export interface ShellOutputFilterInput {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  classification?: ShellClassification;
  validationSummary?: ValidationSummary;
  storeRawOutput?: (content: string) => string;
  fallbackCompact: (text: string, maxChars?: number) => {text: string; truncated: boolean; omittedChars?: number; handle?: string};
  compactMaxChars: number;
}

export interface StreamReduction {
  text: string;
  truncated: boolean;
  filtered: boolean;
  filterName?: string;
  reducerName?: string;
  contentKind?: ReductionContentKind;
  lossy?: boolean;
  parseTier?: ParseTier;
  warning?: string;
  handle?: string;
  rawHandle?: string;
  omittedChars: number;
  rawChars?: number;
  returnedChars?: number;
  rawTokensEstimate?: number;
  returnedTokensEstimate?: number;
  estimatedSavedTokens?: number;
  savingsPct?: number;
}

export interface ShellOutputFilterResult {
  stdout: StreamReduction;
  stderr: StreamReduction;
  summary?: ValidationSummary;
}
