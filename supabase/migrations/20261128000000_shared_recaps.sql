-- P54: shared session recaps. A frozen copy of an ended game's results, readable through a link
-- for 7 days. Only the server (service role) reads and writes it.

create extension if not exists pg_cron with schema pg_catalog;

create table public.shared_recaps (
  -- The public slug: 128 random bits, base64url.
  id text primary key
    constraint shared_recaps_slug_format check (id ~ '^[A-Za-z0-9_-]{22}$'),
  room_code text not null,
  payload jsonb not null
    constraint shared_recaps_payload_size check (pg_column_size(payload) <= 524288),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);

create index shared_recaps_expires_at on public.shared_recaps (expires_at);

-- No policies at all. A "select while not expired" policy would let anyone with the public anon
-- key list every recap, so the slug would protect nothing: reads go through GET /recaps/:slug.
alter table public.shared_recaps enable row level security;
revoke all on table public.shared_recaps from anon, authenticated;
grant select, insert, delete on table public.shared_recaps to service_role;

select cron.schedule(
  'purge-shared-recaps',
  '17 * * * *',
  $$delete from public.shared_recaps where expires_at <= now()$$
);
