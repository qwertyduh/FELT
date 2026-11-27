import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useStore } from 'zustand';
import {
  JOIN_REQUEST_TTL_MS,
  RoomCodeSchema,
  RoomPreviewSchema,
  type RoomCode,
  type RoomPreview,
} from '@felt/protocol';
import { HostInbox } from '../components/HostInbox';
import { WaitingRoom } from '../components/WaitingRoom';
import { apiFetch } from '../lib/api';
import { useAuthStore } from '../lib/authStore';
import { getWebEnv } from '../lib/env';
import { createJoinSession, type JoinSession, type JoinState } from '../lib/joinSession';
import { useConnectionStore } from '../lib/realtime/connectionStore';
import { useRoomStore } from '../lib/realtime/roomStore';
import {
  authStoreToken,
  createSocketClient,
  type SocketClient,
} from '../lib/realtime/socketClient';

const PRIMARY =
  'min-h-14 w-full rounded-2xl bg-brass px-4 text-lg font-semibold text-felt-950 transition active:brightness-90 disabled:bg-felt-800 disabled:text-cream/40';
const SECONDARY =
  'min-h-14 w-full rounded-2xl border border-brass px-4 text-lg font-semibold text-brass active:brightness-90 disabled:border-felt-700 disabled:text-cream/30';

const chips = (n: number) => n.toLocaleString('en-US');
const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Re-renders a few times a second so a countdown to an absolute deadline stays honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Message in the middle, actions at the bottom where the thumb is. */
function Screen({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
        <div role="status" className="w-full">
          <h1 className="font-display text-3xl font-semibold text-balance wrap-anywhere text-cream">
            {title}
          </h1>
        </div>
        {children}
      </div>
      {actions && (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 bg-felt-900 px-4 pt-3 pb-1">
          {actions}
        </div>
      )}
    </>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="max-w-[min(32ch,100%)] text-base wrap-anywhere text-cream/75">{children}</p>
);

const HomeLink = () => (
  <Link to="/" className={`flex items-center justify-center ${SECONDARY}`}>
    Go home
  </Link>
);

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-3">
      <dt className="text-base text-cream/75">{label}</dt>
      <dd className="text-right text-lg text-cream tabular-nums">{value}</dd>
    </div>
  );
}

function PreviewScreen({
  preview,
  busy,
  disabled,
  problem,
  onRequest,
}: {
  preview: RoomPreview;
  busy: boolean;
  disabled: boolean;
  problem: string | null;
  onRequest: () => void;
}) {
  const buyIn =
    preview.maxBuyIn === null
      ? `${chips(preview.minBuyIn)} or more`
      : `${chips(preview.minBuyIn)} to ${chips(preview.maxBuyIn)}`;
  return (
    <>
      <div className="flex flex-1 flex-col justify-center py-4">
        <h1 className="font-display text-3xl font-semibold wrap-anywhere text-cream">
          {preview.hostUsername}&apos;s table
        </h1>
        <p className="mt-1 text-base text-cream/75">
          {preview.mode === 'hybrid'
            ? 'Hybrid: real cards, the app tracks bets.'
            : 'Online: the app deals the cards.'}
        </p>
        <dl className="mt-5 divide-y divide-felt-700 rounded-2xl border-2 border-brass-dim bg-felt-950/70 px-4">
          <Fact
            label="Blinds"
            value={`${chips(preview.smallBlind)} / ${chips(preview.bigBlind)}`}
          />
          <Fact label="Buy-in" value={buyIn} />
          <Fact label="Seats taken" value={`${preview.seatsTaken} of ${preview.maxSeats}`} />
        </dl>
      </div>
      <div className="sticky bottom-0 -mx-4 bg-felt-900 px-4 pt-3 pb-1">
        {problem && (
          <p role="alert" className="mb-3 text-center text-base text-chip-red">
            {problem}
          </p>
        )}
        <button type="button" className={PRIMARY} disabled={disabled || busy} onClick={onRequest}>
          {busy ? 'Asking…' : 'Request to join'}
        </button>
        <p className="mt-2 text-center text-sm text-cream/60">The host approves every player.</p>
      </div>
    </>
  );
}

const RING = 2 * Math.PI * 54;

function PendingScreen({
  deadline,
  host,
  disabled,
  problem,
  onCancel,
}: {
  deadline: number;
  host: string;
  disabled: boolean;
  problem: string | null;
  onCancel: () => void;
}) {
  const left = Math.max(0, deadline - useNow());
  const share = Math.min(1, left / JOIN_REQUEST_TTL_MS);
  return (
    <Screen
      title={`Waiting for ${host}`}
      actions={
        <button type="button" className={SECONDARY} disabled={disabled} onClick={onCancel}>
          Cancel request
        </button>
      }
    >
      <div className="relative size-40">
        <svg viewBox="0 0 120 120" aria-hidden="true" className="size-full -rotate-90">
          <circle cx="60" cy="60" r="54" fill="none" strokeWidth="8" className="stroke-felt-950" />
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - share)}
            className="stroke-brass"
          />
        </svg>
        <p
          role="timer"
          data-testid="join-countdown"
          className="absolute inset-0 flex items-center justify-center font-display text-4xl text-cream tabular-nums"
        >
          {clock(left)}
        </p>
      </div>
      <Note>Your request is with the host. Keep this page open.</Note>
      {problem && <p className="text-base text-chip-red">{problem}</p>}
    </Screen>
  );
}

function DeniedScreen({
  until,
  disabled,
  onRequest,
}: {
  until: number;
  disabled: boolean;
  onRequest: () => void;
}) {
  const left = Math.max(0, until - useNow());
  return (
    <Screen
      title="The host said no"
      actions={
        <>
          <button
            type="button"
            className={PRIMARY}
            disabled={disabled || left > 0}
            onClick={onRequest}
          >
            Request again
          </button>
          <HomeLink />
        </>
      }
    >
      {left > 0 ? (
        <>
          <Note>You can ask again in</Note>
          <p
            role="timer"
            data-testid="cooldown"
            className="font-display text-5xl text-brass tabular-nums"
          >
            {clock(left)}
          </p>
        </>
      ) : (
        <Note>You can ask again now.</Note>
      )}
    </Screen>
  );
}

function EnteredScreen({
  userId,
  online,
  client,
}: {
  userId: string;
  online: boolean;
  client: SocketClient;
}) {
  const room = useRoomStore((s) => s.room);
  return (
    <div data-testid="entered-room" className="flex flex-1 flex-col">
      {room ? (
        <WaitingRoom room={room} userId={userId} ready={online} client={client} />
      ) : (
        <Screen title="You're in">
          <Note>
            {online ? 'The seats are being set up. Hang tight.' : 'Finding the table again…'}
          </Note>
        </Screen>
      )}
      <HostInbox userId={userId} ready={online} client={client} />
    </div>
  );
}

function Body({
  session,
  state,
  userId,
  client,
}: {
  client: SocketClient;
  session: JoinSession;
  state: JoinState;
  userId: string;
}) {
  const { phase, preview, previewError, connected, problem } = state;
  const authFailed = useConnectionStore((s) => s.status === 'error');
  const host = preview?.hostUsername ?? 'the host';

  if (phase.name === 'missing') return <MissingRoom />;
  if (phase.name === 'ended' || (phase.name === 'preview' && preview?.status === 'ended')) {
    return (
      <Screen title="This game has ended" actions={<HomeLink />}>
        <Note>Ask the host for a new room link.</Note>
      </Screen>
    );
  }
  if (phase.name === 'entered') {
    return <EnteredScreen userId={userId} online={state.ready} client={client} />;
  }

  const retry = (
    <button type="button" className={PRIMARY} onClick={() => session.retry()}>
      Try again
    </button>
  );
  if (authFailed) {
    return (
      <Screen title="Can't connect" actions={retry}>
        <Note>The table wouldn&apos;t accept your sign-in.</Note>
      </Screen>
    );
  }

  switch (phase.name) {
    case 'pending':
      return (
        <PendingScreen
          deadline={phase.deadline}
          host={host}
          disabled={!connected}
          problem={problem}
          onCancel={() => session.cancel()}
        />
      );
    case 'denied':
      return (
        <DeniedScreen
          until={phase.until}
          disabled={!connected}
          onRequest={() => session.request()}
        />
      );
    case 'expired':
      return (
        <Screen
          title="No answer"
          actions={
            <>
              <button
                type="button"
                className={PRIMARY}
                disabled={!connected}
                onClick={() => session.request()}
              >
                Request again
              </button>
              <HomeLink />
            </>
          }
        >
          <Note>Your request expired before {host} answered.</Note>
        </Screen>
      );
    case 'entering':
      return (
        <Screen title="You're in">
          <Note>{problem ?? 'Pulling up your chair…'}</Note>
        </Screen>
      );
    case 'preview':
    case 'requesting':
      if (preview) {
        return (
          <PreviewScreen
            preview={preview}
            busy={phase.name === 'requesting'}
            disabled={!connected}
            problem={problem}
            onRequest={() => session.request()}
          />
        );
      }
  }
  // Still finding out (or the preview is missing).
  if (previewError) {
    return (
      <Screen title="Something went wrong" actions={retry}>
        <Note>{previewError}</Note>
      </Screen>
    );
  }
  return (
    <Screen title="Finding the table…">
      {problem && <Note>{problem}</Note>}
      {!connected && <Note>Connecting to the server…</Note>}
    </Screen>
  );
}

function MissingRoom() {
  return (
    <Screen title="No such room" actions={<HomeLink />}>
      <Note>Check the code, or ask the host for the link again. Rooms close when idle.</Note>
    </Screen>
  );
}

function Frame({ code, children }: { code: string; children: ReactNode }) {
  return (
    <section
      className="flex flex-1 flex-col"
      style={{ animation: 'felt-rise 380ms cubic-bezier(0.2, 0.7, 0.2, 1) both' }}
    >
      <header className="flex items-center justify-between gap-3">
        <Link to="/" className="inline-flex min-h-11 items-center text-base text-brass">
          <span aria-hidden="true" className="mr-2">
            ←
          </span>
          Home
        </Link>
        <p
          data-testid="room-code"
          className="min-w-0 truncate font-display text-lg tracking-widest text-brass"
        >
          {code}
        </p>
      </header>
      {children}
    </section>
  );
}

function Visit({ code, userId }: { code: RoomCode; userId: string }) {
  // Nothing here touches the network until `start()`.
  const [{ client, session }] = useState(() => {
    const client = createSocketClient({ url: getWebEnv().serverUrl, getToken: authStoreToken });
    const session = createJoinSession({
      code,
      userId,
      client,
      fetchPreview: async () => RoomPreviewSchema.parse(await apiFetch(`/rooms/${code}`)),
    });
    return { client, session };
  });

  // One socket per visit: connected on mount, dropped on leaving.
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  return (
    <Frame code={code}>
      <Connected session={session} userId={userId} client={client} />
    </Frame>
  );
}

function Connected({
  session,
  userId,
  client,
}: {
  session: JoinSession;
  userId: string;
  client: SocketClient;
}) {
  const state = useStore(session.store);
  const lost = !state.connected && !['loading', 'missing', 'ended'].includes(state.phase.name);
  return (
    <>
      {lost && (
        <p role="status" className="mt-1 text-center text-sm text-chip-red">
          Reconnecting…
        </p>
      )}
      <Body session={session} state={state} userId={userId} client={client} />
    </>
  );
}

export function Room() {
  const { code: raw = '' } = useParams<{ code: string }>();
  const userId = useAuthStore((s) => s.userId);
  const parsed = RoomCodeSchema.safeParse(raw);
  if (!parsed.success) {
    return (
      <Frame code={raw}>
        <MissingRoom />
      </Frame>
    );
  }
  if (!userId) return null; // the route guard shows its splash until sign-in finishes
  return <Visit key={`${userId}:${parsed.data}`} code={parsed.data} userId={userId} />;
}
