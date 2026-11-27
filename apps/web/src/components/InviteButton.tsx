import { useEffect, useState } from 'react';

/** Share sheet where there is one, else the clipboard, else the link to copy by hand. */
export function InviteButton({ code }: { code: string }) {
  const [result, setResult] = useState<'copied' | 'manual' | null>(null);
  const url = `${window.location.origin}/r/${code}`;

  useEffect(() => {
    if (result !== 'copied') return;
    const id = setTimeout(() => setResult(null), 3_000);
    return () => clearTimeout(id);
  }, [result]);

  async function invite() {
    if (typeof navigator.share === 'function') {
      try {
        return await navigator.share({ title: 'Join my FELT table', url });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return; // sheet dismissed
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setResult('copied');
    } catch {
      setResult('manual'); // no clipboard (e.g. plain http) or permission refused
    }
  }

  return (
    <>
      <button
        type="button"
        className="min-h-11 shrink-0 rounded-xl border border-brass px-3 text-base font-semibold text-brass active:brightness-90"
        onClick={() => void invite()}
      >
        <span aria-live="polite">{result === 'copied' ? 'Link copied' : 'Invite'}</span>
      </button>
      {result === 'manual' && (
        <p className="w-full text-sm text-cream/75">
          Copy this link: <span className="break-all text-cream select-all">{url}</span>
        </p>
      )}
    </>
  );
}
