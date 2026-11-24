import { useParams } from 'react-router';
export function Room() {
  const { code } = useParams<{ code: string }>();
  return (
    <section>
      <h1 className="text-2xl font-semibold">Room</h1>
      <p data-testid="room-code">{code}</p>
    </section>
  );
}
