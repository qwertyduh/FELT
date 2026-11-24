import { Link } from 'react-router';
import { protocolName } from '@felt/protocol';
import { useAppStore } from '../store/app';

export function Home() {
  const appName = useAppStore((s) => s.appName);
  return (
    <section>
      <h1 className="text-4xl font-bold tracking-wide">{appName}</h1>
      <p className="mt-2 text-sm opacity-70">Home (protocol: {protocolName})</p>
      <nav className="mt-6 flex flex-col gap-2 underline">
        <Link to="/onboarding">Onboarding</Link>
        <Link to="/practice">Practice</Link>
        <Link to="/learn">Learn</Link>
      </nav>
    </section>
  );
}
