-- Public users table
CREATE TABLE public.users (
  id UUID NOT NULL PRIMARY KEY,
  username TEXT UNIQUE,
  chip_balance INTEGER NOT NULL DEFAULT 1000,
  hands_played INTEGER NOT NULL DEFAULT 0,
  hands_won INTEGER NOT NULL DEFAULT 0,
  total_chips_won INTEGER NOT NULL DEFAULT 0,
  biggest_pot INTEGER NOT NULL DEFAULT 0,
  vpip FLOAT NOT NULL DEFAULT 0.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles are viewable by everyone." ON public.users FOR SELECT USING (true);
CREATE POLICY "Users can update own profile." ON public.users FOR UPDATE USING (auth.uid() = id);
