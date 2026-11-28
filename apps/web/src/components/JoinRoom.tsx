/**
 * Home's way into somebody else's room: a button that opens one field for the code or the invite
 * link, then goes to the room page, where asking to join works as it does from a link.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { parseRoomCode } from '../lib/roomCode';

const OUTLINE =
  'min-h-14 rounded-2xl border border-brass px-4 text-lg font-semibold text-brass active:brightness-90';

export function JoinRoom() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);

  if (!open) {
    return (
      <button type="button" className={`mt-3 w-full ${OUTLINE}`} onClick={() => setOpen(true)}>
        Join a room
      </button>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const code = parseRoomCode(value);
    if (!code) return setBad(true);
    void navigate(`/r/${code}`);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Join a room" className="mt-3 scroll-mb-4">
      <label htmlFor="room-code" className="mb-1 block text-sm text-cream/75">
        Room code or invite link
      </label>
      <div className="flex gap-2">
        <input
          id="room-code"
          type="text"
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="FELT-7KQ2"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(false);
          }}
          aria-invalid={bad}
          aria-describedby={bad ? 'room-code-error' : undefined}
          className="min-h-14 w-full min-w-0 rounded-2xl border-2 border-brass-dim bg-felt-950 px-3 text-xl text-cream placeholder:text-cream/40 aria-invalid:border-chip-red"
        />
        <button
          type="submit"
          className="min-h-14 shrink-0 rounded-2xl bg-brass px-5 text-lg font-semibold text-felt-950 active:brightness-90"
        >
          Join
        </button>
      </div>
      {bad && (
        <p id="room-code-error" role="alert" className="mt-1 text-sm text-chip-red">
          That doesn&apos;t look like a room code. It&apos;s 4 characters, like FELT-7KQ2.
        </p>
      )}
    </form>
  );
}
