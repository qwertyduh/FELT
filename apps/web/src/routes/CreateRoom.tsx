import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { CreateRoomResponseSchema, MAX_SEATS, MIN_SEATS, TURN_TIMER_OPTIONS } from '@felt/protocol';
import { apiFetch } from '../lib/api';
import {
  createRoomErrorMessage,
  initialRoomForm,
  validateRoomForm,
  withMode,
  type FieldName,
  type GameMode,
  type RoomForm,
} from '../lib/createRoom';

const MODES: { value: GameMode; title: string; text: string }[] = [
  { value: 'online', title: 'Online', text: 'The app deals the cards.' },
  { value: 'hybrid', title: 'Hybrid', text: 'Real cards. The app tracks bets.' },
];

const BOX =
  'rounded-2xl border-2 bg-felt-950/70 shadow-[inset_0_2px_10px_rgba(0,0,0,0.45)] focus-within:ring-2 focus-within:ring-brass/60';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 font-display text-lg font-semibold text-cream">{title}</legend>
      {children}
    </fieldset>
  );
}

interface NumberFieldProps {
  name: FieldName;
  label: string;
  value: string;
  error: string | undefined;
  placeholder?: string;
  onChange: (value: string) => void;
}

/**
 * Keeps a field and its message clear of the sticky footer: `scroll-mb-36` on the wrapper reserves
 * the footer's height, and `nearest` does not move a field that is already clear of it.
 */
function reveal(input: HTMLElement | null | undefined): void {
  input?.closest('[data-field]')?.scrollIntoView?.({ block: 'nearest' });
}

function NumberField({ name, label, value, error, placeholder, onChange }: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // An error that appears while typing adds a line here and grows the footer.
  useEffect(() => {
    if (error && document.activeElement === inputRef.current) reveal(inputRef.current);
  }, [error]);

  return (
    <div data-field className="min-w-0 scroll-mt-4 scroll-mb-36">
      <label htmlFor={name} className="mb-1 block text-sm text-cream/75">
        {label}
      </label>
      <div className={`${BOX} ${error ? 'border-chip-red' : 'border-brass-dim'}`}>
        <input
          ref={inputRef}
          id={name}
          name={name}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="done"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${name}-error` : undefined}
          className="min-h-13 w-full min-w-0 bg-transparent px-3 text-xl text-cream tabular-nums outline-none placeholder:text-base placeholder:text-cream/50"
        />
      </div>
      {error && (
        <p id={`${name}-error`} className="mt-1 text-sm text-chip-red">
          {error}
        </p>
      )}
    </div>
  );
}

interface SegmentedProps<T> {
  name: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

function Segmented<T extends string | number>({
  name,
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="flex gap-1 rounded-2xl bg-felt-950/70 p-1">
      {options.map((o) => (
        <label key={o.value} className="relative flex-1">
          <input
            type="radio"
            name={name}
            className="peer sr-only"
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl text-base text-cream/75 peer-checked:bg-brass peer-checked:font-semibold peer-checked:text-felt-950 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brass">
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}

const STEP_BUTTON =
  'min-h-12 w-16 rounded-xl border border-brass text-2xl text-brass active:brightness-90 disabled:border-felt-700 disabled:text-cream/30';

export function CreateRoom() {
  const navigate = useNavigate();
  const [form, setForm] = useState<RoomForm>(() => initialRoomForm());
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const result = validateRoomForm(form);
  const errors = result.ok ? {} : result.errors;

  function update(patch: Partial<RoomForm>) {
    setServerError(null);
    setForm((f) => ({ ...f, ...patch }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    if (!result.ok) {
      const first = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
      first?.focus({ preventScroll: true });
      reveal(first);
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await apiFetch(
        '/rooms',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.settings),
        },
        { retryUnavailable: false },
      );
      const { code } = CreateRoomResponseSchema.parse(res);
      // If the host already walked away from this screen, don't yank them into the room.
      if (mounted.current) void navigate(`/r/${code}`);
    } catch (err) {
      if (!mounted.current) return;
      setServerError(createRoomErrorMessage(err));
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section
      className="flex flex-1 flex-col"
      style={{ animation: 'felt-rise 380ms cubic-bezier(0.2, 0.7, 0.2, 1) both' }}
    >
      <header>
        <Link to="/" className="inline-flex min-h-11 items-center text-base text-brass">
          <span aria-hidden="true" className="mr-2">
            ←
          </span>
          Back
        </Link>
        <h1 className="font-display text-3xl font-semibold text-cream">Set up your table</h1>
      </header>

      <form
        ref={formRef}
        onSubmit={(e) => void onSubmit(e)}
        className="mt-5 flex flex-1 flex-col"
        noValidate
      >
        <div className="flex flex-col gap-6 pb-6">
          <Group title="Mode">
            <div className="grid grid-cols-2 gap-3">
              {MODES.map((m) => (
                <label key={m.value} className="relative">
                  <input
                    type="radio"
                    name="mode"
                    className="peer sr-only"
                    aria-label={m.title}
                    checked={form.mode === m.value}
                    onChange={() => {
                      setServerError(null);
                      setForm((f) => withMode(f, m.value));
                    }}
                  />
                  <span className="flex h-full cursor-pointer flex-col rounded-2xl border-2 border-felt-700 bg-felt-950/50 p-3 peer-checked:border-brass peer-checked:bg-felt-800 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brass">
                    <span className="font-display text-xl font-semibold text-cream">{m.title}</span>
                    <span className="mt-1 text-sm leading-snug text-cream/75">{m.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </Group>

          <Group title="Buy-in">
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                name="minBuyIn"
                label="Minimum"
                value={form.minBuyIn}
                error={errors.minBuyIn}
                onChange={(minBuyIn) => update({ minBuyIn })}
              />
              <NumberField
                name="maxBuyIn"
                label="Maximum"
                placeholder="No limit"
                value={form.maxBuyIn}
                error={errors.maxBuyIn}
                onChange={(maxBuyIn) => update({ maxBuyIn })}
              />
            </div>
          </Group>

          <Group title="Blinds">
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                name="smallBlind"
                label="Small blind"
                value={form.smallBlind}
                error={errors.smallBlind}
                onChange={(smallBlind) => update({ smallBlind })}
              />
              <NumberField
                name="bigBlind"
                label="Big blind"
                value={form.bigBlind}
                error={errors.bigBlind}
                onChange={(bigBlind) => update({ bigBlind })}
              />
            </div>
          </Group>

          <Group title="Seats">
            <div className="flex items-center justify-between rounded-2xl bg-felt-950/70 p-1">
              <button
                type="button"
                aria-label="Fewer seats"
                className={STEP_BUTTON}
                disabled={form.maxSeats <= MIN_SEATS}
                onClick={() => update({ maxSeats: form.maxSeats - 1 })}
              >
                −
              </button>
              <output aria-live="polite" data-testid="seat-count" className="text-xl tabular-nums">
                {form.maxSeats} players
              </output>
              <button
                type="button"
                aria-label="More seats"
                className={STEP_BUTTON}
                disabled={form.maxSeats >= MAX_SEATS}
                onClick={() => update({ maxSeats: form.maxSeats + 1 })}
              >
                +
              </button>
            </div>
          </Group>

          <Group title="Turn timer">
            <Segmented
              name="turnTimer"
              value={form.turnTimerSeconds ?? 0}
              options={[
                { value: 0, label: 'Off' },
                ...TURN_TIMER_OPTIONS.map((s) => ({ value: s as number, label: `${s}s` })),
              ]}
              onChange={(v) =>
                update({
                  turnTimerSeconds: TURN_TIMER_OPTIONS.find((s) => s === v) ?? null,
                  timerChosen: true,
                })
              }
            />
          </Group>

          <Group title="Blind increase">
            <Segmented
              name="blindIncrease"
              value={form.blindIncreaseOn ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On a timer' },
              ]}
              onChange={(v) => update({ blindIncreaseOn: v === 'on' })}
            />
            {form.blindIncreaseOn && (
              <div className="mt-3">
                <NumberField
                  name="blindIncreaseMinutes"
                  label="Every how many minutes?"
                  placeholder="Minutes"
                  value={form.blindIncreaseMinutes}
                  error={errors.blindIncreaseMinutes}
                  onChange={(blindIncreaseMinutes) => update({ blindIncreaseMinutes })}
                />
              </div>
            )}
          </Group>
        </div>

        {/* Stays within thumb reach however far the form is scrolled. */}
        <div className="sticky bottom-0 -mx-4 mt-auto border-t border-felt-700 bg-felt-900 px-4 pt-3 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
          {serverError && (
            <p
              role="alert"
              data-testid="create-room-error"
              className="mb-3 rounded-xl border border-chip-red/60 bg-felt-950/80 px-3 py-2 text-base text-chip-red"
            >
              {serverError}
            </p>
          )}
          {!result.ok && (
            <p role="status" className="mb-2 text-center text-sm text-chip-red">
              Fix the highlighted fields to continue.
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="min-h-14 w-full rounded-2xl bg-brass px-4 text-lg font-semibold text-felt-950 transition active:brightness-90 disabled:bg-felt-800 disabled:text-cream/40"
          >
            {submitting ? 'Creating…' : 'Create room'}
          </button>
        </div>
      </form>
    </section>
  );
}
