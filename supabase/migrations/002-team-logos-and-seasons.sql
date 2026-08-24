-- ============================================================================
--  002 - team logos, member editing, and season history
--
--  - memberships.logo_url        a crest per team
--  - memberships.jersey          fallback colour when there is no image
--  - competitions.seasons        finished seasons, archived rather than lost
--  - storage policies for the public "team-logos" bucket
--
--  Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  1. Team identity
-- ---------------------------------------------------------------------------

alter table public.memberships add column if not exists logo_url text;

-- When no crest is uploaded the app draws initials on this colour, so a team
-- always has some identity rather than a grey box.
alter table public.memberships add column if not exists jersey text default '#00c853';

-- ---------------------------------------------------------------------------
--  2. Seasons
--
--  Generating fixtures wipes the current schedule. Rolling to a new season
--  archives the finished one first, so past tables and results stay readable
--  instead of being overwritten.
-- ---------------------------------------------------------------------------

alter table public.competitions add column if not exists archived_seasons jsonb not null default '[]'::jsonb;

/**
 * Close the current season and start the next.
 * The caller passes the final published snapshot; it is appended to
 * archived_seasons and the season counter moves on.
 */
create or replace function public.roll_season(p_competition uuid, p_snapshot jsonb)
  returns int language plpgsql volatile security definer set search_path = public as $fn$
declare next_season int;
begin
  if not public.can_manage_competition(p_competition) then
    raise exception 'you do not manage this competition' using errcode = '42501';
  end if;

  update public.competitions
     set archived_seasons = archived_seasons || jsonb_build_array(
           jsonb_build_object(
             'season',   season,
             'endedAt',  extract(epoch from now()) * 1000,
             'snapshot', coalesce(p_snapshot, '{}'::jsonb)
           )),
         season = season + 1,
         status = 'setup'
   where id = p_competition
   returning season into next_season;

  return next_season;
end $fn$;

grant execute on function public.roll_season(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
--  3. Storage policies for team-logos
--
--  The bucket is public to read, so crests render without signed URLs. Writes
--  are restricted to signed-in members, and the first folder segment must be a
--  tenant the caller belongs to - that stops one league overwriting another
--  league's crests.
-- ---------------------------------------------------------------------------

drop policy if exists "team logos are publicly readable" on storage.objects;
create policy "team logos are publicly readable" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'team-logos');

drop policy if exists "members upload team logos" on storage.objects;
create policy "members upload team logos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'team-logos'
    and (storage.foldername(name))[1]::uuid = any(public.my_tenant_ids())
  );

drop policy if exists "members replace team logos" on storage.objects;
create policy "members replace team logos" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'team-logos'
    and (storage.foldername(name))[1]::uuid = any(public.my_tenant_ids())
  );

drop policy if exists "members remove team logos" on storage.objects;
create policy "members remove team logos" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-logos'
    and (storage.foldername(name))[1]::uuid = any(public.my_tenant_ids())
  );
