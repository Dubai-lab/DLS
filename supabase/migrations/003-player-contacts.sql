-- ============================================================================
--  003 - player contact numbers (WhatsApp)
--
--  Players need to reach their opponent to arrange a match. The number lives on
--  the membership and is published to a `contacts` document.
--
--  `contacts` is deliberately NOT covered by a league's public_view setting.
--  Standings can be public; phone numbers never are. The old single-tenant app
--  kept numbers in a world-readable node - fine when there was one private
--  league, wrong the moment strangers can browse a public one.
--
--  Safe to re-run.
-- ============================================================================

alter table public.memberships add column if not exists phone text;

-- ---------------------------------------------------------------------------
--  Read rule: contacts require membership, whatever public_view says
-- ---------------------------------------------------------------------------

create or replace function public.db_can_read(p_tenant uuid, p_path text) returns boolean
  language plpgsql stable security definer set search_path = public as $fn$
declare
  parts     text[] := public.db_split(p_path);
  is_public boolean;
begin
  if parts[1] is null then return false; end if;

  -- Admin working state is never public.
  if parts[1] = 'comp' and parts[3] = 'admin' then
    return public.can_manage_competition(public.db_competition_for(p_tenant, parts));
  end if;

  -- Contact details are for members of this league only. Checked before the
  -- public_view fallback below, so opting into public standings cannot leak
  -- anyone's phone number.
  if parts[1] = 'contacts' then
    return public.is_member(p_tenant);
  end if;

  if public.is_member(p_tenant) then return true; end if;

  select public_view into is_public from public.tenants where id = p_tenant;
  return coalesce(is_public, false);
end $fn$;
