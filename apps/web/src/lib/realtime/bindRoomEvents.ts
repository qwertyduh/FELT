import type { FeltSocket } from './socketClient';
import {
  addJoinRequest,
  addTopUpRequest,
  applyHostInbox,
  applyPrivateHand,
  applyRoomState,
  markNeedsResync,
} from './roomStore';

type Listenable = Pick<FeltSocket, 'on' | 'off'>;

/** Wires server events into the room store. Returns an unbind function. */
export function bindRoomEvents(socket: Listenable): () => void {
  const onState = (p: unknown) => void applyRoomState(p);
  const onHand: Parameters<FeltSocket['on']>[1] = ((p: Parameters<typeof applyPrivateHand>[0]) =>
    applyPrivateHand(p)) as never;
  let firstConnect = true;
  const onConnect = () => {
    if (!firstConnect) markNeedsResync();
    firstConnect = false;
  };
  socket.on('room:state', onState);
  socket.on('hand:private', onHand as never);
  socket.on('host:inbox', applyHostInbox);
  socket.on('host:join_request', addJoinRequest);
  socket.on('host:topup_request', addTopUpRequest);
  socket.on('connect', onConnect);
  return () => {
    socket.off('room:state', onState);
    socket.off('hand:private', onHand as never);
    socket.off('host:inbox', applyHostInbox);
    socket.off('host:join_request', addJoinRequest);
    socket.off('host:topup_request', addTopUpRequest);
    socket.off('connect', onConnect);
  };
}
