/**
 * What the table view (P39) derives from `room:state`: where seats sit, what the money amounts to
 * and whose turn it is. Read-only: every rule is the server's, nothing here decides anything.
 */
import type { PublicHand, PublicRoomState, PublicSeat } from '@felt/protocol';

type Spot = readonly [x: number, y: number];

const BOTTOM: Spot = [0.5, 1];
const TOP: readonly Spot[] = [[0.5, 0]];
const TOP_PAIR: readonly Spot[] = [
  [0.33, 0],
  [0.67, 0],
];

/** The bottom seat, up the left side (heights given), across the top and down the mirrored right. */
const ring = (sides: readonly number[], across: readonly Spot[]): readonly Spot[] => [
  BOTTOM,
  ...sides.map((y): Spot => [0, y]),
  ...across,
  ...[...sides].reverse().map((y): Spot => [1, y]),
];

/**
 * Seat positions on a portrait table for 2 to 9 seats, as fractions of the free width and height.
 * Seat 1 is nearest the thumb and numbers run clockwise, as on the waiting-room map. Laid out so
 * the boxes do not overlap on a 320px screen at the table's smallest height.
 */
const LAYOUTS: Readonly<Record<number, readonly Spot[]>> = {
  2: ring([], TOP),
  3: ring([0.25], []),
  4: ring([0.5], TOP),
  5: ring([0.65], TOP_PAIR),
  6: ring([0.72, 0.25], TOP),
  7: ring([0.72, 0.25], TOP_PAIR),
  8: ring([0.78, 0.5, 0.22], TOP),
  9: ring([0.78, 0.5, 0.22], TOP_PAIR),
};

export function seatPosition(index: number, count: number): { x: number; y: number } {
  const [x, y] = LAYOUTS[count]![index]!;
  return { x, y };
}

/** Everything in the middle: collected pots plus this street's bets, leavers' included. */
export function potTotal(room: PublicRoomState): number {
  const collected = room.hand?.pots.reduce((sum, p) => sum + p.amount, 0) ?? 0;
  const departed = room.hand?.departedBet ?? 0;
  return collected + departed + room.seats.reduce((sum, s) => sum + (s?.bet ?? 0), 0);
}

export const potName = (index: number, count: number) =>
  index > 0 ? `Side ${index}` : count > 1 ? 'Main' : 'Pot';

/** What this player must put in to call, or null when they have no decision left in this hand. */
export function toCall(hand: PublicHand | null, me: PublicSeat): number | null {
  if (!hand || hand.street === 'ended' || me.handStatus !== 'active') return null;
  return Math.min(Math.max(0, hand.currentBet - me.bet), me.stack);
}

const STREET_NAMES: Readonly<Record<PublicHand['street'], string>> = {
  preflop: 'Pre-flop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  ended: 'Hand over',
};
/**
 * The disconnected player this viewer may fold now (hybrid or not): they are the host, the turn
 * timer is off and the game is waiting on that player. The server checks it all again.
 */
export function absentActor(room: PublicRoomState, userId: string): PublicSeat | null {
  const { hand } = room;
  if (room.hostId !== userId || room.status !== 'playing' || room.paused) return null;
  if (room.settings.turnTimerSeconds !== null) return null;
  if (!hand || hand.street === 'ended' || hand.currentActor === null) return null;
  const seat = room.seats[hand.currentActor];
  return seat && !seat.connected && seat.userId !== userId ? seat : null;
}

export const streetName = (street: PublicHand['street']) => STREET_NAMES[street];

const NEXT_DEAL: Partial<Record<PublicHand['street'], string>> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
};

/**
 * Players the next deal would take: seated, not sitting out, with chips. Approved top-ups are added
 * before the hand is dealt, so they count.
 */
export function readyPlayers(room: PublicRoomState): number {
  return room.seats.filter(
    (s) => s && !s.sittingOut && (s.stack > 0 || (room.pendingTopUps[s.userId] ?? 0) > 0),
  ).length;
}

/**
 * Hybrid: the hand has ended and nothing happens until the host starts the next one (the real cards
 * need gathering first). A game that is ending ends by itself.
 */
export const awaitingNextHand = (room: PublicRoomState): boolean =>
  room.settings.mode === 'hybrid' &&
  room.status === 'playing' &&
  !room.paused &&
  !room.ending &&
  room.hand?.street === 'ended';

/** One line saying what the table is waiting for. */
export function turnLine(room: PublicRoomState, userId: string): string {
  const { hand } = room;
  if (room.status === 'ended') return 'This game has ended';
  if (room.paused) return 'Game paused';
  if (!hand) return 'Waiting for the host to start';
  if (hand.street === 'ended') {
    // The felt already says "Hand over". One line, even at 320px: there is no height to spare.
    if (!awaitingNextHand(room)) return 'Hand over';
    if (readyPlayers(room) < 2) return 'Need 2 players for the next hand';
    return room.hostId === userId
      ? 'Shuffle, then tap Next hand'
      : "Waiting for the host's next hand";
  }
  if (hand.pendingAwards.some((a) => a.disputed)) return 'Award disputed';
  if (hand.pendingAwards.length > 0) return 'Awarding the pot';
  const actor = hand.currentActor === null ? null : room.seats[hand.currentActor];
  if (actor) {
    if (actor.userId === userId) return 'Your turn';
    return actor.connected ? `${actor.username}'s turn` : `${actor.username} is away`;
  }
  // Online the server deals by itself: there is no host step to wait for.
  if (room.settings.mode === 'online') return 'Dealing…';
  const hosting = room.hostId === userId;
  if (hand.street === 'showdown') {
    return hosting ? 'Pick the winners' : 'Waiting for the host to pick the winner';
  }
  const next = NEXT_DEAL[hand.street];
  if (hosting) return next ? `Deal the ${next}` : 'Betting is done';
  return next ? `Waiting for the host to deal the ${next}` : 'Waiting for the host';
}
