import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';

export type AuthStatus = 'loading' | 'signedIn' | 'error';

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  userId: string | null;
  isAnonymous: boolean;
  error: string | null;
}

export const initialAuthState: AuthState = {
  status: 'loading',
  session: null,
  userId: null,
  isAnonymous: false,
  error: null,
};

export const useAuthStore = create<AuthState>(() => initialAuthState);

/** Mirror a Supabase session into the store. A null session keeps `loading` (or a standing error). */
export function applySession(session: Session | null): void {
  if (session) {
    useAuthStore.setState({
      status: 'signedIn',
      session,
      userId: session.user.id,
      isAnonymous: session.user.is_anonymous ?? false,
      error: null,
    });
  } else {
    const { status, error } = useAuthStore.getState();
    useAuthStore.setState({
      ...initialAuthState,
      status: status === 'error' ? 'error' : 'loading',
      error: status === 'error' ? error : null,
    });
  }
}

export function setAuthError(message: string): void {
  useAuthStore.setState({ ...initialAuthState, status: 'error', error: message });
}

export function setAuthLoading(): void {
  useAuthStore.setState(initialAuthState);
}
