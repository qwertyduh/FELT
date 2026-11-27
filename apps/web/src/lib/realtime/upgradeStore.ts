import { PROTOCOL_VERSION } from '@felt/protocol';
import { create } from 'zustand';

/**
 * Why this bundle cannot go on with this server: the handshake refused its protocol version, or a
 * payload did not fit its schema. There is no service worker and index.html is revalidated on every
 * load, so a plain reload fetches the current bundle. Reloading is only ever the user's tap.
 */
export interface UpgradeState {
  handshake: boolean;
  payload: boolean;
  /** The server's version from the refusal, if it said. */
  serverProtocol: number | null;
  /** This version already reloaded a short while ago and is still here. */
  reloaded: boolean;
}

const initial: UpgradeState = {
  handshake: false,
  payload: false,
  serverProtocol: null,
  reloaded: false,
};

export const useUpgradeStore = create<UpgradeState>(() => initial);

export const RELOAD_KEY = 'felt-reload';
export const RELOAD_MEMORY_MS = 10 * 60_000;

/** Whether a reload from this same version is recent (kept per tab, across the reload). */
function reloadedRecently(): boolean {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? 'null') as {
      version?: unknown;
      at?: unknown;
    } | null;
    return (
      saved?.version === PROTOCOL_VERSION &&
      typeof saved.at === 'number' &&
      Date.now() - saved.at < RELOAD_MEMORY_MS
    );
  } catch {
    return false;
  }
}

export function requireReload(
  why: 'handshake' | 'payload',
  serverProtocol: number | null = null,
): void {
  useUpgradeStore.setState({
    [why]: true,
    reloaded: reloadedRecently(),
    ...(why === 'handshake' ? { serverProtocol } : {}),
  });
}

export function clearUpgrade(why: 'handshake' | 'payload'): void {
  if (!useUpgradeStore.getState()[why]) return;
  useUpgradeStore.setState({
    [why]: false,
    ...(why === 'handshake' ? { serverProtocol: null } : {}),
  });
}

export function resetUpgrade(): void {
  useUpgradeStore.setState(initial);
}

export const needsReload = (s: UpgradeState): boolean => s.handshake || s.payload;

/** Reloading will not help yet: the server is the older side, or a reload has just been tried. */
export const updateNotReady = (s: UpgradeState): boolean =>
  s.reloaded || (s.serverProtocol !== null && s.serverProtocol < PROTOCOL_VERSION);

/** Typed by hand: server tests compile this file without DOM types. */
const reloadPage = (): void =>
  (globalThis as unknown as { location: { reload(): void } }).location.reload();

export function reloadForUpdate(reload: () => void = reloadPage): void {
  try {
    sessionStorage.setItem(
      RELOAD_KEY,
      JSON.stringify({ version: PROTOCOL_VERSION, at: Date.now() }),
    );
  } catch {
    // Without storage the screen just offers the same reload again.
  }
  reload();
}
