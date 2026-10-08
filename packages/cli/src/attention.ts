/**
 * Decides when an AI agent in a session has stopped and is waiting for you.
 *
 * There is no protocol for "the agent wants input", so this is a heuristic on
 * the PTY stream: an agent that is working keeps repainting (spinners, streamed
 * text), so a burst of output followed by silence means it has settled on a
 * prompt, a question or a permission request.
 */

/** Silence after output that counts as "settled". */
export const QUIET_MS = 6_000;
/** Ignore bursts smaller than this — a stray redraw is not an answer. */
export const MIN_BURST_BYTES = 120;
/** Someone typed this recently: they are at the keyboard, don't ping them. */
export const ACTIVE_USER_MS = 20_000;

// ANSI CSI/OSC sequences and other control bytes.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Last few readable lines of terminal output, for the notification body. */
export function summarizeTail(buffer: string, maxChars = 140): string {
  const text = buffer.slice(-4000).replace(ANSI_RE, '');
  const lines = text
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/[─-╿▀-▟]+/g, ' ').trim())
    .filter((l) => l.length > 2);
  const tail = lines.slice(-2).join(' · ');
  if (!tail) return 'Waiting for your input';
  return tail.length > maxChars ? '…' + tail.slice(tail.length - maxChars + 1) : tail;
}

export interface AttentionState {
  bytesSinceInput: number;
  lastInputMs: number;
  notified: boolean;
}

export function newAttentionState(): AttentionState {
  return { bytesSinceInput: 0, lastInputMs: 0, notified: false };
}

/** Should a quiet session raise a notification right now? */
export function shouldNotify(s: AttentionState, tool: string, now: number): boolean {
  if (tool === 'bash') return false; // a plain shell is always "waiting"
  if (s.notified) return false;
  if (s.bytesSinceInput < MIN_BURST_BYTES) return false;
  if (now - s.lastInputMs < ACTIVE_USER_MS) return false;
  return true;
}
