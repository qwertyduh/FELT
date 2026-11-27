/**
 * The single builder of `room:state` payloads. Privacy rule: every object here is written field by
 * field (an allow-list). Never spread a room, seat, hand or player object: that is how hole cards,
 * the deck, the ledger or join requests would leak.
 */
import type { HandState } from '@felt/engine';
import type { PublicHand, PublicRoomState, PublicSeat } from '@felt/protocol';
import type { RoomRecord } from './roomStore';

/** A running hand as the server holds it: the engine state plus what the engine does not track. */
export interface LiveHand {
  handId: string;
  state: HandState;
  /** Absolute epoch ms; null when there is no turn timer. */
  turnDeadline: number | null;
  /** Hybrid: proposed awards in their dispute window (not the engine's `pendingAwards`). */
  proposedAwards?: PublicHand['pendingAwards'];
  /** Dealt-in players who gave up their seat: they are not matched to any seat. */
  departed?: readonly string[];
}

function toPublicHand({ handId, state, turnDeadline, proposedAwards }: LiveHand): PublicHand {
  return {
    handId,
    street: state.street,
    board: [...state.board],
    pots: state.pots.map((p) => ({ id: p.id, amount: p.amount, eligible: [...p.eligible] })),
    currentBet: state.currentBet,
    lastFullRaise: state.lastFullRaise,
    currentActor: state.currentActor,
    button: state.button,
    smallBlindSeat: state.smallBlindSeat,
    bigBlindSeat: state.bigBlindSeat,
    turnDeadline,
    awaitingHost:
      state.mode === 'hybrid' && state.street !== 'ended' && state.currentActor === null,
    pendingAwards: (proposedAwards ?? []).map((a) => ({
      potId: a.potId,
      winners: [...a.winners],
      confirmAt: a.confirmAt,
      disputed: a.disputed,
    })),
  };
}

/** The room's stored hand in the builder's shape. */
export function liveHandOf(room: Readonly<RoomRecord>): LiveHand | null {
  const hand = room.game?.hand;
  if (!hand) return null;
  const { proposal } = hand;
  return {
    handId: hand.handId,
    state: hand.state,
    turnDeadline: null, // P48
    departed: hand.departed,
    ...(proposal
      ? {
          proposedAwards: proposal.awards.map((a) => ({
            potId: a.potId,
            winners: a.winners,
            confirmAt: proposal.confirmAt,
            disputed: proposal.disputed,
          })),
        }
      : {}),
  };
}

export function toPublicState(
  room: Readonly<RoomRecord>,
  hand: LiveHand | null,
  isConnected: (userId: string) => boolean = () => false,
): PublicRoomState {
  const s = room.settings;
  const seats = Array.from({ length: s.maxSeats }, (_, i): PublicSeat | null => {
    const seat = room.seats.find((x) => x.seat === i);
    if (!seat) return null;
    const player = hand?.departed?.includes(seat.userId)
      ? undefined
      : hand?.state.players.find((p) => p.playerId === seat.userId);
    // While a hand runs the engine owns the stack; once it has ended, the room record does.
    const running = player !== undefined && hand?.state.street !== 'ended';
    return {
      seat: i,
      userId: seat.userId,
      username: seat.username,
      stack: running ? player.stack : seat.stack,
      bet: player?.bet ?? 0,
      handStatus: player?.status ?? null,
      sittingOut: seat.sittingOut,
      connected: isConnected(seat.userId),
      muted: false, // P55
    };
  });
  return {
    version: room.version,
    code: room.code,
    status: room.status,
    settings: {
      mode: s.mode,
      minBuyIn: s.minBuyIn,
      maxBuyIn: s.maxBuyIn,
      smallBlind: s.smallBlind,
      bigBlind: s.bigBlind,
      maxSeats: s.maxSeats,
      turnTimerSeconds: s.turnTimerSeconds,
      blindIncreaseMinutes: s.blindIncreaseMinutes,
    },
    hostId: room.hostId,
    seats,
    button: hand?.state.button ?? room.game?.button ?? null,
    hand: hand ? toPublicHand(hand) : null,
    pendingTopUps: {}, // P43
    nextBlindIncreaseAt: null, // not scheduled yet
    paused: room.status === 'paused',
  };
}
