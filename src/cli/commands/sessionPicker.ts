import type {SessionSummary} from '../../core/session/sessionStore.js';
import type {TextInputSuggestion} from '../../ui/components/TextInput.js';

export const MAX_SESSION_PICKER_RESULTS = 20;
export const SESSION_ACTIONS = {resume: 'resume', fork: 'fork'} as const;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sessionSuggestions(sessions: SessionSummary[]): TextInputSuggestion[] {
  return sessions.slice(0, MAX_SESSION_PICKER_RESULTS).map(session => ({
    value: session.id,
    description: `${formatDate(session.lastActivityAt)} · ${session.messageCount} msg${session.messageCount === 1 ? '' : 's'} · ${formatBytes(session.sizeBytes)}${session.lastStatus ? ` · ${session.lastStatus}` : ''}${session.parseErrors.length ? ' · ⚠ malformed lines' : ''}${session.firstUserPreview ? ` · “${session.firstUserPreview}”` : ''}`,
    kind: 'session',
  }));
}

export function sessionActionSuggestions(): TextInputSuggestion[] {
  return [
    {value: SESSION_ACTIONS.resume, description: 'Resume this session', kind: 'session'},
    {value: SESSION_ACTIONS.fork, description: 'Start a new session from its latest snapshot', kind: 'session'},
  ];
}
