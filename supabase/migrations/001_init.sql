-- HypeCheck database, version 1.
--
-- posts    one row per distinct post (matched by a hash of its cleaned text), with its latest result
-- checks   one row each time anyone checks a post; no account or personal data
-- history  which posts a signed-in user checked (used once sign-in is added)
-- follows  tickers a signed-in user follows (used once sign-in is added)
--
-- Access: browsers never write posts or checks; only the server does, with the secret key.
-- Signed-in users can read and delete their own history and follows, and read the posts in
-- their own history. Nothing is readable by signed-out visitors.

create table public.posts (
  hash        text primary key,
  text        text not null,
  tickers     text[] not null default '{}',
  result      jsonb not null,
  extractor   text not null,
  version     integer not null,                 -- bumps when verdict logic changes, so old results aren't reused
  checked_at  timestamptz not null default now(), -- when this result was computed
  first_seen  timestamptz not null default now()
);

create table public.checks (
  id          uuid primary key default gen_random_uuid(),
  post_hash   text not null references public.posts (hash) on delete cascade,
  source      text not null default 'paste' check (source in ('paste', 'screenshot', 'share', 'cli')),
  device      text,                              -- random id stored in the browser, not tied to a person
  env         text not null default 'production', -- production, preview or development
  cached      boolean not null default false,    -- true when a saved result was reused
  created_at  timestamptz not null default now()
);
create index checks_post_hash_idx on public.checks (post_hash);
create index checks_created_at_idx on public.checks (created_at desc);

create table public.history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  post_hash   text not null references public.posts (hash) on delete cascade,
  created_at  timestamptz not null default now()
);
create index history_user_idx on public.history (user_id, created_at desc);

create table public.follows (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ticker      text not null check (ticker ~ '^[A-Z]{1,5}([.-][A-Z])?$'),
  created_at  timestamptz not null default now(),
  primary key (user_id, ticker)
);

alter table public.posts   enable row level security;
alter table public.checks  enable row level security;
alter table public.history enable row level security;
alter table public.follows enable row level security;

-- Server (secret key). It bypasses row rules but still needs table access,
-- because new tables aren't exposed automatically in this project.
grant select, insert, update on public.posts   to service_role;
grant select, insert         on public.checks  to service_role;
grant select, insert, delete on public.history to service_role;
grant select, insert, delete on public.follows to service_role;

-- Signed-in users: their own rows only.
grant select, delete on public.history to authenticated;
create policy "read own history"   on public.history for select to authenticated using (user_id = (select auth.uid()));
create policy "delete own history" on public.history for delete to authenticated using (user_id = (select auth.uid()));

grant select on public.posts to authenticated;
create policy "read posts in own history" on public.posts for select to authenticated
  using (exists (select 1 from public.history h where h.post_hash = posts.hash and h.user_id = (select auth.uid())));

grant select, insert, delete on public.follows to authenticated;
create policy "read own follows"   on public.follows for select to authenticated using (user_id = (select auth.uid()));
create policy "add own follows"    on public.follows for insert to authenticated with check (user_id = (select auth.uid()));
create policy "delete own follows" on public.follows for delete to authenticated using (user_id = (select auth.uid()));

-- Most-checked posts, for testing now and an Explore page later.
-- Only the server can read it (security_invoker keeps the row rules above in force).
create view public.post_stats with (security_invoker = true) as
select p.hash,
       p.text,
       p.tickers,
       count(c.id)                                    as checks,
       count(distinct c.device)                       as devices,
       max(c.created_at)                              as last_checked
from public.posts p
join public.checks c on c.post_hash = p.hash
where c.env = 'production'
group by p.hash;
grant select on public.post_stats to service_role;
