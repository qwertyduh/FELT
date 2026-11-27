import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  checkUsernameLocally,
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_MIN,
} from '@felt/protocol';
import { AppealDialog } from '../components/AppealDialog';
import { apiFetch } from '../lib/api';
import { useAuthStore } from '../lib/authStore';
import { loadMe, setClaimedUsername } from '../lib/meStore';
import { returnToFrom } from '../lib/returnTo';
import { verdictFromError, type Verdict } from '../lib/usernameCopy';
import { useUsernameCheck } from '../lib/useUsernameCheck';

type Tone = 'hint' | 'pending' | 'ok' | 'bad';
interface Feedback {
  tone: Tone;
  text: string;
  appeal?: boolean;
}

const TONE_CLASS: Record<Tone, string> = {
  hint: 'text-cream/70',
  pending: 'text-cream/70',
  ok: 'text-chip-green',
  bad: 'text-chip-red',
};
const TONE_GLYPH: Record<Tone, string> = { hint: '', pending: '…', ok: '✓', bad: '✕' };

function verdictFeedback(v: Verdict): Feedback {
  if (v.kind === 'rejected') {
    return { tone: 'bad', text: v.message, appeal: v.reason === 'profane' };
  }
  if (v.kind === 'error') return { tone: 'bad', text: v.message };
  return { tone: 'pending', text: 'You already have a username. Taking you home…' };
}

export function Onboarding() {
  const navigate = useNavigate();
  const returnTo = returnToFrom(useLocation().state);
  const userId = useAuthStore((s) => s.userId);
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claimVerdict, setClaimVerdict] = useState<{ name: string; verdict: Verdict } | null>(null);
  const [appealOpen, setAppealOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const name = normalizeUsername(raw);
  const local = checkUsernameLocally(raw);
  const check = useUsernameCheck(raw.trim() === '' || !local.available ? null : name);

  let feedback: Feedback;
  if (raw.trim() === '') {
    feedback = {
      tone: 'hint',
      text: `${USERNAME_MIN} to ${USERNAME_MAX} letters, numbers or underscores.`,
    };
  } else if (!local.available) {
    feedback = { tone: 'bad', text: local.message };
  } else if (claimVerdict?.name === name) {
    feedback = verdictFeedback(claimVerdict.verdict);
  } else if (check.kind === 'idle' || check.kind === 'checking') {
    feedback = { tone: 'pending', text: 'Checking…' };
  } else if (check.kind === 'available') {
    feedback = { tone: 'ok', text: `${name} is available.` };
  } else {
    feedback = verdictFeedback(check);
  }

  const canSubmit = raw.trim() !== '' && local.available && !submitting && userId !== null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !userId) return;
    setSubmitting(true);
    try {
      const res = await apiFetch<{ username: string }>('/me/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      // The server returns the normalised name: use it.
      setClaimedUsername(userId, typeof res?.username === 'string' ? res.username : name);
      void navigate(returnTo, { replace: true });
    } catch (err) {
      const verdict = verdictFromError(err);
      if (verdict.kind === 'already_set') {
        setClaimVerdict({ name, verdict });
        await loadMe(userId, { force: true }); // route guard then sends them on
        void navigate(returnTo, { replace: true });
        return;
      }
      setClaimVerdict({ name, verdict });
      if (verdict.kind === 'rejected' && verdict.reason === 'profane') setAppealOpen(true);
      setSubmitting(false);
    }
  }

  return (
    <section
      className="flex flex-1 flex-col"
      style={{ animation: 'felt-rise 380ms cubic-bezier(0.2, 0.7, 0.2, 1) both' }}
    >
      <header className="pt-10">
        <p className="font-display text-sm tracking-[0.4em] text-brass">FELT</p>
        <h1 className="mt-4 font-display text-4xl leading-tight font-semibold text-cream">
          What should we call you at the table?
        </h1>
        <p className="mt-3 max-w-[32ch] text-base text-cream/75">
          Friends see this name next to your chips.
        </p>
      </header>

      <form onSubmit={(e) => void onSubmit(e)} className="mt-8 flex flex-1 flex-col" noValidate>
        <label htmlFor="username" className="sr-only">
          Username
        </label>
        <div className="flex items-center rounded-2xl border-2 border-brass bg-felt-950/70 px-4 shadow-[inset_0_2px_10px_rgba(0,0,0,0.45)] focus-within:ring-2 focus-within:ring-brass/60">
          <span aria-hidden="true" className="font-display text-2xl text-brass-dim">
            @
          </span>
          <input
            id="username"
            ref={inputRef}
            type="text"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            inputMode="text"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={64}
            placeholder="yourname"
            aria-describedby="username-feedback"
            aria-invalid={raw.trim() !== '' && feedback.tone === 'bad'}
            className="min-h-16 w-full min-w-0 bg-transparent px-2 text-2xl text-cream outline-none placeholder:text-cream/30"
          />
        </div>

        <div
          id="username-feedback"
          role="status"
          aria-live="polite"
          data-testid="username-feedback"
          data-tone={feedback.tone}
          className={`mt-3 min-h-14 text-base ${TONE_CLASS[feedback.tone]}`}
        >
          <p>
            {TONE_GLYPH[feedback.tone] && (
              <span aria-hidden="true" className="mr-2">
                {TONE_GLYPH[feedback.tone]}
              </span>
            )}
            {feedback.text}
          </p>
          {feedback.appeal && (
            <button
              type="button"
              onClick={() => setAppealOpen(true)}
              className="mt-1 min-h-11 text-left text-brass underline underline-offset-4"
            >
              Think this is a mistake?
            </button>
          )}
        </div>

        <div className="mt-auto pt-6">
          <button
            type="submit"
            disabled={!canSubmit}
            className="min-h-14 w-full rounded-2xl bg-brass px-4 text-lg font-semibold text-felt-950 transition active:brightness-90 disabled:bg-felt-800 disabled:text-cream/40"
          >
            {submitting ? 'Claiming…' : 'Claim username'}
          </button>
        </div>
      </form>

      {appealOpen && (
        <AppealDialog
          onClose={() => {
            setAppealOpen(false);
          }}
        />
      )}
    </section>
  );
}
