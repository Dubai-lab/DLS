-- ============================================================================
--  006 - divisions that promote and relegate, cups that draw from a league
--
--  Two things an organiser otherwise does by hand every season:
--
--   * moving the bottom of Division 1 down and the top of Division 2 up
--   * entering the league's top 16 into the cup
--
--  Both are the same underlying operation - move a set of teams from one
--  competition to another - so both go through move_members().
--
--  Safe to re-run.
-- ============================================================================

alter table public.competitions add column if not exists promotes_to    uuid references public.competitions(id) on delete set null;
alter table public.competitions add column if not exists relegates_to   uuid references public.competitions(id) on delete set null;
alter table public.competitions add column if not exists promote_count  int not null default 0;
alter table public.competitions add column if not exists relegate_count int not null default 0;

-- A cup draws its entrants from a league rather than having members of its own.
alter table public.competitions add column if not exists qualifies_from uuid references public.competitions(id) on delete set null;
alter table public.competitions add column if not exists qualify_count  int not null default 0;

-- ---------------------------------------------------------------------------
--  Moving teams between competitions
--
--  memberships.competition_ids is the source of truth for who plays where, so
--  promotion, relegation and cup qualification are all edits to that array.
--  Done in one statement per call so a half-applied swap cannot leave a team
--  in both divisions or in neither.
-- ---------------------------------------------------------------------------

/**
 * Move the named teams out of one competition and into another.
 * Passing null for p_from adds without removing, which is what cup
 * qualification wants: a side stays in its league while playing the cup.
 */
create or replace function public.move_members(
  p_tenant uuid, p_from uuid, p_to uuid, p_teams text[]
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
           -- array_remove first so a team already in the destination does not
           -- end up listed twice.
           array_append(
             array_remove(
               array_remove(m.competition_ids, p_to),
               coalesce(p_from, '00000000-0000-0000-0000-000000000000'::uuid)),
             p_to)
   where m.tenant_id = p_tenant
     and m.role = 'player'
     and m.team is not null
     and lower(m.team) = any (select lower(t) from unnest(p_teams) t);

  get diagnostics moved = row_count;
  return moved;
end $fn$;

grant execute on function public.move_members(uuid, uuid, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
--  Reading a finished season's final table
--
--  Promotion and qualification both need the standings a season ended on.
--  Taken from the published document rather than recomputed, so the teams that
--  go up are exactly the ones players saw at the top.
-- ---------------------------------------------------------------------------

create or replace function public.final_table(p_tenant uuid, p_competition uuid)
  returns jsonb
  language plpgsql stable security definer set search_path = public as $fn$
declare
  comp public.competitions%rowtype;
  doc  jsonb;
begin
  if not public.is_member(p_tenant) then
    raise exception 'not your league' using errcode = '42501';
  end if;

  select * into comp from public.competitions
   where id = p_competition and tenant_id = p_tenant;
  if comp.id is null then return null; end if;

  select d.data into doc from public.documents d
   where d.tenant_id = p_tenant and d.path = 'comp/' || comp.key;

  return coalesce(doc #> '{pub,table}', '[]'::jsonb);
end $fn$;

grant execute on function public.final_table(uuid, uuid) to authenticated;
