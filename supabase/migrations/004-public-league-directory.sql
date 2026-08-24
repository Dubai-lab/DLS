-- ============================================================================
--  004 - public league directory
--
--  Leagues can opt into a listing on the landing page so players anywhere can
--  find them. "Join" forwards to a channel the organiser controls - a WhatsApp
--  group, a Telegram channel, a Discord invite - where they admit people
--  however they already do.
--
--  Nothing about membership changes: the organiser still registers each player
--  against an email. This only solves discovery.
--
--  Safe to re-run.
-- ============================================================================

alter table public.tenants add column if not exists listed        boolean not null default false;
alter table public.tenants add column if not exists tagline       text;
alter table public.tenants add column if not exists join_url      text;
alter table public.tenants add column if not exists join_platform text;
alter table public.tenants add column if not exists region        text;
alter table public.tenants add column if not exists join_clicks   int not null default 0;
alter table public.tenants add column if not exists listed_at     timestamptz;

-- Only https destinations. A directory that forwards to arbitrary URLs is an
-- open redirect, and http would strip that protection anyway.
alter table public.tenants drop constraint if exists tenants_join_url_https;
alter table public.tenants add constraint tenants_join_url_https
  check (join_url is null or join_url ~ '^https://');

create index if not exists tenants_listed_idx
  on public.tenants(listed) where listed;

-- ---------------------------------------------------------------------------
--  Reading the directory
--
--  Returned through a function rather than by loosening the tenants policy:
--  the table holds the owner id, plan and status, none of which belong on a
--  public page. This returns only what the listing needs.
-- ---------------------------------------------------------------------------

create or replace function public.list_public_leagues(p_limit int default 60)
  returns table (
    id uuid, name text, slug text, tagline text, game_type text,
    region text, join_url text, join_platform text, logo_url text,
    players int, competitions int
  )
  language sql stable security definer set search_path = public as $fn$
  select
    t.id, t.name, t.slug, t.tagline, t.game_type,
    t.region, t.join_url, t.join_platform, t.logo_url,
    (select count(*)::int from public.memberships m
      where m.tenant_id = t.id and m.role = 'player')            as players,
    (select count(*)::int from public.competitions c
      where c.tenant_id = t.id)                                  as competitions
  from public.tenants t
  where t.listed
    and t.status = 'active'
    and t.join_url is not null
  -- Busiest first; a directory of empty leagues persuades nobody.
  order by players desc, t.listed_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 60), 200))
$fn$;

-- ---------------------------------------------------------------------------
--  Interest counter
--
--  Lets an organiser see whether the listing is doing anything. Deliberately
--  crude: it counts button presses, not people, and nothing depends on it
--  being exact.
-- ---------------------------------------------------------------------------

create or replace function public.record_join_click(p_tenant uuid)
  returns void language sql volatile security definer set search_path = public as $fn$
  update public.tenants
     set join_clicks = join_clicks + 1
   where id = p_tenant and listed
$fn$;

grant execute on function public.list_public_leagues(int) to anon, authenticated;
grant execute on function public.record_join_click(uuid) to anon, authenticated;
