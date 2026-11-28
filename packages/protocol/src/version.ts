/*
 * The web app and the server deploy separately, and open tabs keep old bundles. A client states its
 * protocol version in the socket handshake and the server refuses any other (or none).
 */

/**
 * One fingerprint per wire format, oldest first. `version.test.ts` fails when a schema that crosses
 * the wire changes: APPEND the fingerprint it prints (never edit or remove an entry), which raises
 * the version. Also append an entry (any new unique string) for a change in meaning that the
 * schemas cannot show.
 */
export const WIRE_FINGERPRINTS = [
  '8b9336e3',
  'd0aa94a4',
  '8fcdfffe',
  'c7097c27',
  'f0dc5b9d',
  '21ec94e3',
  '448f8ef8',
] as const;

export const PROTOCOL_VERSION: number = WIRE_FINGERPRINTS.length;

/** The `connect_error` message and `data.code` of the refusal. */
export const UPGRADE_REQUIRED = 'upgrade_required';

/** Socket `handshake.auth`. */
export interface HandshakeAuth {
  token: string;
  protocol: number;
}

/**
 * The handshake refusal for another protocol version: `connect_error.data`. Not an auth failure:
 * the token was not looked at. `protocol` is the server's, so a client can tell which side is old.
 */
export interface UpgradeRequiredData {
  code: typeof UPGRADE_REQUIRED;
  protocol: number;
}
