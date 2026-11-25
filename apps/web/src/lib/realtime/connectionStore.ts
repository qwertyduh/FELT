import { create } from 'zustand';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Last handshake error code (`unauthorized`, `token_expired`, ...) or message. */
  error: string | null;
}

export const initialConnectionState: ConnectionState = { status: 'idle', error: null };

export const useConnectionStore = create<ConnectionState>(() => initialConnectionState);

export function setConnectionStatus(status: ConnectionStatus, error: string | null = null): void {
  useConnectionStore.setState({ status, error });
}
