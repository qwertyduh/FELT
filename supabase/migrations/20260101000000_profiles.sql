-- P06: profiles. One row per player (anonymous Supabase users included),
-- holding the unique username. Only the server (service role) writes.

create extension if not exists citext with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- citext: 'Bob' and 'bob' are the same username.
  username extensions.citext not null unique
    constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Anonymous users also use the `authenticated` role in Supabase.
create policy "profiles are readable by signed-in users"
  on public.profiles
  for select
  to authenticated
  using (true);

-- No insert/update/delete policies: the service role (bypasses RLS) is the only writer.
-- Defence in depth: also remove the write privileges Supabase grants by default.
revoke all on table public.profiles from anon;
revoke insert, update, delete, truncate, references, trigger on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;
