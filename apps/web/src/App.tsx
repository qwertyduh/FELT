import { Route, Routes } from 'react-router';
import { Home } from './routes/Home';
import { Learn } from './routes/Learn';
import { NotFound } from './routes/NotFound';
import { Onboarding } from './routes/Onboarding';
import { Practice } from './routes/Practice';
import { Recap } from './routes/Recap';
import { Room } from './routes/Room';

export function App() {
  return (
    <div className="flex min-h-dvh justify-center">
      <main
        className="flex min-h-dvh w-full max-w-[480px] flex-col p-4"
        style={{
          paddingTop: 'max(1rem, env(safe-area-inset-top))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        }}
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/r/:code" element={<Room />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/learn" element={<Learn />} />
          <Route path="/recap/:slug" element={<Recap />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
