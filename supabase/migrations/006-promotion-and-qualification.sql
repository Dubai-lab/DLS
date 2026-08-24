-- ============================================================================
--  006 - divisions that promote, relegate, and send teams to a cup
--
--  Two jobs an organiser otherwise does by hand every season:
--
--   * moving the bottom of Division 1 down and the top of Division 2 up
--   * entering the qualifying sides into the cup
--
--  Every rule lives on the DIVISION, never on the cup. A cup is fed by as many
--  divisions as the organiser likes - 8 from Division 1, 4 from Division 2,
--  4 from Division 3 - and a rule stored on the cup could only name one source.
--  The cup itself needs no configuration: it receives whoever qualifies.
--
--  Safe to re-run.
-- ============================================================================

alter table public.competitions add column if not exists promotes_to    uuid references public.competitions(id) on delete set null;
alter table public.competitions add column if not exists relegates_to   uuid references public.competitions(id) on delete set null;
alter table public.competitions add column if not exists promote_count  int not null default 0;
alter table public.competitions add column if not exists relegate_count int not null default 0;

-- Which cup this division feeds, and how many of its teams go.
alter table public.competitions add column if not exists qualifies_to  uuid references public.competitions(id) on delete set null;
alter table public.competitions add column if not exists qualify_count int not null default 0;

create index if not exists competitions_feeds_idx
  on public.competitions(qualifies_to) where qualifies_to is not null;

-- ---------------------------------------------------------------------------
--  Moving teams between competitions
--
--  memberships.competition_ids is the source of truth for who plays where, so
--  promotion, relegation and cup qualification are all edits to that array.
--  Done in one statement per call, so a half-applied swap cannot leave a team
--  in both divisions or in neither.
-- ---------------------------------------------------------------------------

/**
 * Move the named teams out of one competition and into another.
 *
 * p_from null adds without removing, which is what cup qualification wants: a
 * side keeps playing its division while in the cup.
 *
 * p_keep is the competition those sides must not lose. An empty
 * competition_ids means "every competition" to the app - the default a member
 * is registered with - so the first write to it has to make that implicit
 * membership explicit, or entering the cup would silently drop the division
 * the side came from.
 */
drop function if exists public.move_members(uuid, uuid, uuid, text[]);

create or replace function public.move_members(
  p_tenant uuid, p_from uuid, p_to uuid, p_teams text[], p_keep uuid default null
) returns int
  language plpgsql volatile security definer set search_path = public as $fn$
declare moved int;
begin
  if not public.is_tenant_owner(p_tenant) then
    raise exception 'only the league owner can move teams' using errcode = '42501';
  end if;
  if p_to is null then
    raise exception 'a destination competition is required';
  end if;

  update public.memberships m
     set competition_ids =
           -- Remove the destination first, so a team already entered does not
           -- end up listed twice.
           array_append(
             array_remove(
               array_remove(
                 case when cardinality(m.competition_ids) = 0 and p_keep is not null
                      then array[p_keep]
                      else m.competition_ids end,
                 p_to),
               coalesce(p_from, '00000000-0000-0000-0000-000000000000'::uuid)),
             p_to)
   where m.tenant_id = p_tenant
     and m.role = 'player'
     and m.team is not null
     and lower(m.team) = any (select lower(t) from unnest(p_teams) t);

  get diagnostics moved = row_count;
  return moved;
end $fn$;

grant execute on function public.move_members(uuid, uuid, uuid, text[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
--  Reading a finished season's final table
--
--  Promotion and qualification both need the standings a season ended on.
--  Taken from the published document rather than recomputed, so the teams that
--  move are exactly the ones players saw at the top and bottom.
--
--  Falls back to the newest archived season when the live table is empty, so
--  filling a cup still works after its feeding divisions have rolled over. The
--  organiser should not have to get the order right.
-- ---------------------------------------------------------------------------

create or replace function public.final_table(p_tenant uuid, p_competition uuid)
  returns jsonb
  language plpgsql stable security definer set search_path = public as $fn$
declare
  comp  public.competitions%rowtype;
  doc   jsonb;
  live  jsonb;
  past  jsonb;
begin
  if not public.is_member(p_tenant) then
    raise exception 'not your league' using errcode = '42501';
  end if;

  select * into comp from public.competitions
   where id = p_competition and tenant_id = p_tenant;
  if comp.id is null then return null; end if;

  select d.data into doc from public.documents d
   where d.tenant_id = p_tenant and d.path = 'comp/' || comp.key;

  live := coalesce(doc #> '{pub,table}', '[]'::jsonb);
  if jsonb_array_length(live) > 0 then
    return live;
  end if;

  -- Newest archive first; archived_seasons is appended to, so the last entry
  -- is the season that just finished.
  select a.value -> 'snapshot' -> 'table'
    into past
    from jsonb_array_elements(coalesce(comp.archived_seasons, '[]'::jsonb))
           with ordinality as a(value, n)
   where jsonb_typeof(a.value -> 'snapshot' -> 'table') = 'array'
   order by coalesce((a.value ->> 'season')::int, 0) desc, a.n desc
   limit 1;

  return coalesce(past, '[]'::jsonb);
end $fn$;

grant execute on function public.final_table(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
--  Who feeds a cup
--
--  Answers "which divisions send teams here, and how many each" in one call,
--  so the cup can gather its entrants without the organiser restating anything
--  that is already set on the divisions.
-- ---------------------------------------------------------------------------

create or replace function public.cup_feeders(p_tenant uuid, p_cup uuid)
  returns table (id uuid, name text, key text, qualify_count int, season int)
  language sql stable security definer set search_path = public as $fn$
  select c.id, c.name, c.key, c.qualify_count, c.season
  from public.competitions c
  where c.tenant_id = p_tenant
    and c.qualifies_to = p_cup
    and c.qualify_count > 0
    and public.is_member(p_tenant)
  order by c.sort_order, c.created_at
$fn$;

grant execute on function public.cup_feeders(uuid, uuid) to authenticated;
