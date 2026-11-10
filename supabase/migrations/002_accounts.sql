-- Verifi database, version 2: sign-in sync and looser grouping of the same post.

-- 1. Signed-in users add their own checks to their history (the app does this after each check).
--    One row per user per post; checking the same post again keeps the existing row.
alter table public.history add constraint history_user_post_unique unique (user_id, post_hash);
grant insert on public.history to authenticated;
create policy "add own history" on public.history for insert to authenticated
  with check (user_id = (select auth.uid()));

-- 2. group_hash: the same post copied slightly differently (punctuation, emoji, "Show more")
--    gets the same group_hash, so counts treat it as one post. The exact hash still decides
--    when a saved result is reused, since a one-character difference can change a verdict.
alter table public.posts add column group_hash text;
update public.posts set group_hash = hash where group_hash is null;
create index posts_group_hash_idx on public.posts (group_hash);

drop view public.post_stats;
create view public.post_stats with (security_invoker = true) as
select coalesce(p.group_hash, p.hash)                  as group_hash,
       (array_agg(p.text order by p.first_seen))[1]    as text,
       (array_agg(p.tickers order by p.first_seen))[1] as tickers,
       count(distinct p.hash)                          as versions,
       count(c.id)                                     as checks,
       count(distinct c.device)                        as devices,
       max(c.created_at)                               as last_checked
from public.posts p
join public.checks c on c.post_hash = p.hash
where c.env = 'production'
group by coalesce(p.group_hash, p.hash);
grant select on public.post_stats to service_role;
