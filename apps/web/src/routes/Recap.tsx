import { useParams } from 'react-router';
export function Recap() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <section>
      <h1 className="text-2xl font-semibold">Recap</h1>
      <p data-testid="recap-slug">{slug}</p>
    </section>
  );
}
