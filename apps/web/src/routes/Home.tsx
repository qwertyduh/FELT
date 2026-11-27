import { Link } from 'react-router';
import { protocolName } from '@felt/protocol';
import { AuthStatus } from '../components/AuthStatus';
import { useAppStore } from '../store/app';

export function Home() {
  const appName = useAppStore((s) => s.appName);
  return (
    <section>
      <h1 className="text-4xl font-bold tracking-wide">{appName}</h1>
      <p className="mt-2 text-sm opacity-70">Home (protocol: {protocolName})</p>
      <div className="mt-4">
        <AuthStatus />
      </div>
      <Link
        to="/new"
        className="mt-6 flex min-h-14 items-center justify-center rounded-2xl bg-brass px-4 text-lg font-semibold text-felt-950 active:brightness-90"
      >
        Create room
      </Link>
      <nav className="mt-6 flex flex-col gap-2 underline">
        <Link to="/onboarding">Onboarding</Link>
        <Link to="/practice">Practice</Link>
        <Link to="/learn">Learn</Link>
      </nav>
    </section>
  );
}
