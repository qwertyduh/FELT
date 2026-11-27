/** Create-room form logic (PRD 5.2): form state, validation against the shared schema, error copy. */
import {
  defaultRoomSettings,
  MAX_BLIND_INCREASE_MINUTES,
  MAX_CHIPS,
  RoomSettingsSchema,
  type RoomSettings,
} from '@felt/protocol';
import { ApiError } from './apiFetch';

export type GameMode = RoomSettings['mode'];

const CHIP_FIELDS = ['minBuyIn', 'maxBuyIn', 'smallBlind', 'bigBlind'] as const;
type ChipField = (typeof CHIP_FIELDS)[number];
export type FieldName = ChipField | 'blindIncreaseMinutes';
export type FieldErrors = Partial<Record<FieldName, string>>;

/** Typed numbers stay strings until submit, so a half-typed value is never rewritten. */
export interface RoomForm {
  mode: GameMode;
  minBuyIn: string;
  /** Empty = no maximum. */
  maxBuyIn: string;
  smallBlind: string;
  bigBlind: string;
  maxSeats: number;
  turnTimerSeconds: RoomSettings['turnTimerSeconds'];
  /** Until the host picks a timer, it follows the mode's default. */
  timerChosen: boolean;
  blindIncreaseOn: boolean;
  blindIncreaseMinutes: string;
}

/** Hybrid is preselected: it is the mode that can be played today. */
export function initialRoomForm(mode: GameMode = 'hybrid'): RoomForm {
  const d = defaultRoomSettings(mode);
  return {
    mode,
    minBuyIn: String(d.minBuyIn),
    maxBuyIn: d.maxBuyIn === null ? '' : String(d.maxBuyIn),
    smallBlind: String(d.smallBlind),
    bigBlind: String(d.bigBlind),
    maxSeats: d.maxSeats,
    turnTimerSeconds: d.turnTimerSeconds,
    timerChosen: false,
    blindIncreaseOn: d.blindIncreaseMinutes !== null,
    blindIncreaseMinutes: '',
  };
}

export function withMode(form: RoomForm, mode: GameMode): RoomForm {
  return {
    ...form,
    mode,
    turnTimerSeconds: form.timerChosen
      ? form.turnTimerSeconds
      : defaultRoomSettings(mode).turnTimerSeconds,
  };
}

/** Digits only (grouping commas and spaces allowed). Anything else is NaN, never silently fixed. */
function toNumber(raw: string): number {
  const s = raw.replace(/[,\s]/g, '');
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

function chipError(raw: string): string | null {
  if (raw.trim() === '') return 'Enter an amount.';
  const n = toNumber(raw);
  if (Number.isNaN(n)) return 'Use whole numbers only.';
  if (n < 1) return 'Must be at least 1.';
  if (n > MAX_CHIPS) return `Can't be more than ${MAX_CHIPS.toLocaleString('en-US')}.`;
  return null;
}

export type FormResult = { ok: true; settings: RoomSettings } | { ok: false; errors: FieldErrors };

export function validateRoomForm(form: RoomForm): FormResult {
  const errors: FieldErrors = {};
  for (const field of CHIP_FIELDS) {
    if (field === 'maxBuyIn' && form.maxBuyIn.trim() === '') continue;
    const message = chipError(form[field]);
    if (message) errors[field] = message;
  }
  if (form.blindIncreaseOn) {
    const n = toNumber(form.blindIncreaseMinutes);
    if (!(n >= 1 && n <= MAX_BLIND_INCREASE_MINUTES)) {
      errors.blindIncreaseMinutes = `Enter 1 to ${MAX_BLIND_INCREASE_MINUTES} minutes.`;
    }
  }

  const candidate = {
    mode: form.mode,
    minBuyIn: toNumber(form.minBuyIn),
    maxBuyIn: form.maxBuyIn.trim() === '' ? null : toNumber(form.maxBuyIn),
    smallBlind: toNumber(form.smallBlind),
    bigBlind: toNumber(form.bigBlind),
    maxSeats: form.maxSeats,
    turnTimerSeconds: form.turnTimerSeconds,
    blindIncreaseMinutes: form.blindIncreaseOn ? toNumber(form.blindIncreaseMinutes) : null,
  };
  // Cross-field rules are checked here too, so they show even while another field is invalid.
  if (!errors.minBuyIn && !errors.maxBuyIn && candidate.maxBuyIn !== null) {
    if (candidate.minBuyIn > candidate.maxBuyIn) {
      errors.maxBuyIn = "Maximum can't be below the minimum.";
    }
  }
  if (!errors.smallBlind && !errors.bigBlind && candidate.smallBlind > candidate.bigBlind) {
    errors.bigBlind = "Big blind can't be below the small blind.";
  }

  const parsed = RoomSettingsSchema.safeParse(candidate);
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, settings: parsed.data };
  }
  if (!parsed.success) {
    // The shared schema has the last word: surface anything the friendly checks above missed.
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as FieldName;
      errors[field] ??= issue.message;
    }
  }
  return { ok: false, errors };
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

/** What to tell the host when `POST /rooms` fails. */
export function createRoomErrorMessage(err: unknown): string {
  const generic = "Couldn't create the room. Try again.";
  if (!(err instanceof ApiError)) return generic;
  if (err.status === 0) return "Can't reach the server. Check your connection and try again.";
  if (err.status === 429 && err.code === 'too_many_rooms') {
    return 'You already have 5 rooms open, which is the limit. A room closes after 2 hours without activity.';
  }
  if (err.status === 429) {
    const secs = field(err.body, 'retryAfterSeconds');
    return typeof secs === 'number' && secs > 0
      ? `Too many tries. Wait ${Math.ceil(secs)} seconds and try again.`
      : 'Too many tries. Wait a moment and try again.';
  }
  if (err.status === 503) return "The server can't create rooms right now. Try again in a moment.";
  if (err.status === 403 && err.code === 'username_required') {
    return 'Pick a username before creating a room.';
  }
  if (err.status === 422) {
    const issues = field(err.body, 'issues');
    const first: unknown = Array.isArray(issues) ? issues[0] : undefined;
    const message = field(first, 'message');
    const path = field(first, 'path');
    return typeof message === 'string'
      ? `The server rejected these settings: ${typeof path === 'string' && path ? `${path}: ` : ''}${message}`
      : 'The server rejected these settings.';
  }
  return generic;
}
