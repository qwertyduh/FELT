/**
 * The single builder of `room:state` payloads. Privacy rule: every object here is written field by
 * field (an allow-list). Never spread a room, seat, hand or player object: that is how hole cards,
 * the deck, the ledger or join requests would leak.
 */
import { legalActions, potsOnShow, type HandState } from '@felt/engine';
import type { PublicHand, PublicRoomState, PublicSeat, RoomLogEntry } from '@felt/protocol';
import type { RoomRecord } from './roomStore';

/** A running hand as the server holds it: the engine state plus what the engine does not track. */
export interface LiveHand {
  handId: string;
  turnSeq?: number | undefined;
  state: HandState;
  /** Absolute epoch ms; null when there is no turn timer. */
  turnDeadline: number | null;
  /** Hybrid: proposed awards in their dispute window (not the engine's `pendingAwards`). */
  proposedAwards?: PublicHand['pendingAwards'];
  /** Dealt-in players who gave up their seat: they are not matched to any seat. */
  departed?: readonly string[];
  /** The one step an undo would take back (never the history). */
  undo?: PublicHand['undo'];
}

function toPublicOptions(state: HandState): PublicHand['options'] {
  const legal = legalActions(state);
  if (!legal) return null;
  const { check, call, raise } = legal;
  return {
    check,
    call,
    raise: raise ? { type: raise.type, min: raise.min, max: raise.max } : null,
  };
}

function toPublicHand(live: LiveHand): PublicHand {
  const { handId, state, turnDeadline, proposedAwards } = live;
  return {
    handId,
    turnSeq: live.turnSeq ?? 0,
    options: toPublicOptions(state),
    street: state.street,
    board: [...state.board],
    pots: potsOnShow(state).map((p) => ({
      id: p.id,
      amount: p.amount,
      eligible: [...p.eligible],
    })),
    departedBet: state.players
      .filter((p) => live.departed?.includes(p.playerId))
      .reduce((sum, p) => sum + p.bet, 0),
    undo: live.undo ? { action: live.undo.action, userId: live.undo.userId } : null,
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
  const last = hand.undo?.at(-1)?.move;
  return {
    handId: hand.handId,
    turnSeq: hand.turnSeq,
    state: hand.state,
    turnDeadline: null, // P48
    departed: hand.departed,
    undo: last ? { action: last.action, userId: last.userId } : null,
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

function toPublicLogEntry(e: RoomLogEntry): RoomLogEntry {
  const { id, at } = e;
  if (e.kind === 'undo') {
    const { action, username, street } = e;
    return { id, at, kind: 'undo', action, username, street };
  }
  const { username, amount, stack, reason } = e;
  return { id, at, kind: 'adjust', username, amount, stack, reason };
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
    pendingTopUps: Object.fromEntries((room.pendingTopUps ?? []).map((t) => [t.userId, t.amount])),
    nextBlindIncreaseAt: null, // not scheduled yet
    paused: room.status === 'paused',
    log: (room.log ?? []).map(toPublicLogEntry),
  };
}
