-- ============================================================================
--  Football League Hub - multi-tenant platform schema
--
--  Any organiser can register, create a league, and run their own
--  competitions. Each tenant's data is isolated in Postgres, not in the
--  browser: a bug in the app cannot leak League A's fixtures into League B.
--
--  Design split:
--    - Platform metadata (tenants, competitions, memberships) is
--      relational, because it needs real queries and constraints.
--    - Competition state (teams, fixtures, standings) stays JSONB in
--      `documents`, because it is genuinely document-shaped and the generic
--      admin templates work with it directly.
--
--  Run in the Supabase SQL editor. Idempotent - safe to re-run.
--  WARNING: section 0 drops the single-tenant v1 schema and all its data.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
--  0. Drop the single-tenant v1 schema
-- ---------------------------------------------------------------------------

drop function if exists public.db_get(text)                   cascade;
drop function if exists public.db_get_many(text[])            cascade;
drop function if exists public.db_set(text, jsonb)            cascade;
drop function if exists public.db_update(text, jsonb)         cascade;
drop function if exists public.db_delete(text)                cascade;
drop function if exists public.db_can_read(text)              cascade;
drop function if exists public.db_can_write(text)             cascade;
drop function if exists public.db_comp_for_root(text)         cascade;
drop function if exists public.db_is_public_write(text[])     cascade;
drop function if exists public.verify_access_code(text, text) cascade;
drop function if exists public.resolve_access_code(text)      cascade;
drop function if exists public.can_manage(text)               cascade;
drop function if exists public.is_owner()                     cascade;
drop function if exists public.is_admin()                     cascade;

-- All three v1 tables must go. `create table if not exists` further down would
-- otherwise silently skip a table that already exists in its old shape, and the
-- first reference to a new column then fails with "column does not exist".
-- push_tokens is the one that catches you out: v1 created it without tenant_id.
drop table if exists public.admin_profiles cascade;
drop table if exists public.documents      cascade;
drop table if exists public.push_tokens    cascade;

-- ---------------------------------------------------------------------------
--  1. Tables
-- ---------------------------------------------------------------------------

-- One row per customer organisation.
create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  -- what game the league is played on; free text so new titles need no migration
  game_type   text not null default 'other',
  owner_id    uuid references auth.users(id) on delete set null,
  plan        text not null default 'free',
  status      text not null default 'active' check (status in ('active','suspended')),
  -- when true, published standings are readable without signing in
  public_view boolean not null default false,
  logo_url    text,
  created_at  timestamptz not null default now()
);

-- A tenant may run several competitions (Div 1, Div 2, a cup, ...).
create table if not exists public.competitions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null,
  name        text not null,
  -- drives which generic admin template renders; replaces the five bespoke pages
  format      text not null check (format in ('round_robin','group_knockout')),
  season      int  not null default 1,
  status      text not null default 'setup' check (status in ('setup','active','finished')),
  accent      text default '#00c853',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);
create index if not exists competitions_tenant_idx on public.competitions(tenant_id);

-- Who belongs to which tenant, and what they may do there.
-- A person can belong to several tenants with a different role in each.
--
-- Membership is granted by an admin, never self-claimed. The old app let a
-- player pick their team from a list to "log in", which meant identity was
-- self-asserted: anyone who reached the app could select someone else's team
-- and read their data. Now an admin registers each player against their email
-- address, and the team is bound to that account.
create table if not exists public.memberships (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  role            text not null check (role in ('owner','manager','player')),
  -- managers: which competitions they run. players: which they are in.
  competition_ids uuid[] not null default '{}',
  team            text,
  display_name    text,
  -- Denormalised so the console can list members without reading auth.users,
  -- which is not exposed to the client.
  email           text,
  -- 'invited' until the person signs in for the first time.
  status          text not null default 'invited'
                  check (status in ('invited','active','suspended')),
  added_by        uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (user_id, tenant_id)
);
create index if not exists memberships_tenant_idx on public.memberships(tenant_id);
create index if not exists memberships_user_idx   on public.memberships(user_id);
-- One account cannot hold two teams in the same competition set.
create unique index if not exists memberships_team_unique
  on public.memberships(tenant_id, lower(team)) where team is not null;

-- Platform operators (you). Seeded by scripts/seed-platform-admin.mjs.
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Competition state, scoped per tenant.
create table if not exists public.documents (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  path        text not null,
  data        jsonb not null default 'null'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  primary key (tenant_id, path)
);

-- FCM device tokens, now tenant-aware.
create table if not exists public.push_tokens (
  token       text primary key,
  tenant_id   uuid references public.tenants(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  platform    text not null check (platform in ('android','ios','web')),
  comps       text[] not null default '{}',
  team        text,
  device_id   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists push_tokens_tenant_idx on public.push_tokens(tenant_id);

alter table public.tenants         enable row level security;
alter table public.competitions    enable row level security;
alter table public.memberships     enable row level security;
alter table public.platform_admins enable row level security;
alter table public.documents       enable row level security;
alter table public.push_tokens     enable row level security;

-- documents has no policies on purpose; all access is through the RPCs in
-- section 4, which apply the path rules.
revoke all on public.documents from anon, authenticated;

-- ---------------------------------------------------------------------------
--  2. Identity helpers
--     security definer so they can read membership rows without tripping the
--     policies that are themselves defined in terms of these functions.
-- ---------------------------------------------------------------------------

create or replace function public.is_platform_admin() returns boolean
  language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$fn$;

/** Tenants the caller belongs to. */
create or replace function public.my_tenant_ids() returns uuid[]
  language sql stable security definer set search_path = public as $fn$
  select coalesce(array_agg(tenant_id), '{}')
  from public.memberships where user_id = auth.uid()
$fn$;

create or replace function public.my_role(p_tenant uuid) returns text
  language sql stable security definer set search_path = public as $fn$
  select role from public.memberships
  where user_id = auth.uid() and tenant_id = p_tenant
$fn$;

create or replace function public.is_member(p_tenant uuid) returns boolean
  language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and tenant_id = p_tenant
  ) or public.is_platform_admin()
$fn$;

create or replace function public.is_tenant_owner(p_tenant uuid) returns boolean
  language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and tenant_id = p_tenant and role = 'owner'
  ) or public.is_platform_admin()
$fn$;

/** Owner of the tenant, or a manager assigned to this competition. */
create or replace function public.can_manage_competition(p_competition uuid)
  returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1
    from public.competitions c
    join public.memberships m on m.tenant_id = c.tenant_id
    where c.id = p_competition
      and m.user_id = auth.uid()
      and (m.role = 'owner' or
           (m.role = 'manager' and p_competition = any(m.competition_ids)))
  ) or public.is_platform_admin()
$fn$;

-- ---------------------------------------------------------------------------
--  3. Table policies
-- ---------------------------------------------------------------------------

drop policy if exists "members read their tenant" on public.tenants;
create policy "members read their tenant" on public.tenants
  for select to anon, authenticated
  using (public_view or id = any(public.my_tenant_ids()) or public.is_platform_admin());

drop policy if exists "owner updates tenant" on public.tenants;
create policy "owner updates tenant" on public.tenants
  for update to authenticated
  using (public.is_tenant_owner(id)) with check (public.is_tenant_owner(id));

drop policy if exists "members read competitions" on public.competitions;
create policy "members read competitions" on public.competitions
  for select to anon, authenticated
  using (
    public.is_member(tenant_id)
    or exists (select 1 from public.tenants t where t.id = tenant_id and t.public_view)
  );

drop policy if exists "owner writes competitions" on public.competitions;
create policy "owner writes competitions" on public.competitions
  for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));

drop policy if exists "read memberships in my tenants" on public.memberships;
create policy "read memberships in my tenants" on public.memberships
  for select to authenticated
  using (user_id = auth.uid() or public.is_tenant_owner(tenant_id));

drop policy if exists "owner manages memberships" on public.memberships;
create policy "owner manages memberships" on public.memberships
  for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));

drop policy if exists "platform admins read themselves" on public.platform_admins;
create policy "platform admins read themselves" on public.platform_admins
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "register a push token" on public.push_tokens;
create policy "register a push token" on public.push_tokens
  for insert to anon, authenticated with check (true);
drop policy if exists "refresh a push token" on public.push_tokens;
create policy "refresh a push token" on public.push_tokens
  for update to anon, authenticated using (true) with check (true);
drop policy if exists "tenant reads its push tokens" on public.push_tokens;
create policy "tenant reads its push tokens" on public.push_tokens
  for select to authenticated using (public.is_member(tenant_id));

-- ---------------------------------------------------------------------------
--  4. Document store, scoped per tenant
--
--  Path convention:
--    comp/<key>/admin        working state - owner or that competition's manager
--    comp/<key>/pub          published state - any member (or public if opted in)
--    highlights/<key>        clips; reactions writable by members
--    claims/<key>            which member claimed which team
--    news, trophies          tenant-wide
-- ---------------------------------------------------------------------------

create or replace function public.db_split(p_path text) returns text[]
  language sql immutable as $fn$
  select array(
    select s
    from unnest(string_to_array(trim(both '/' from coalesce(p_path, '')), '/')) as s
    where s <> ''
  )
$fn$;

/** Competition id for a 'comp/<key>/...' path within a tenant. */
create or replace function public.db_competition_for(p_tenant uuid, parts text[])
  returns uuid language sql stable security definer set search_path = public as $fn$
  select c.id from public.competitions c
  where c.tenant_id = p_tenant and parts[1] = 'comp' and c.key = parts[2]
$fn$;

create or replace function public.db_can_read(p_tenant uuid, p_path text) returns boolean
  language plpgsql stable security definer set search_path = public as $fn$
declare
  parts text[] := public.db_split(p_path);
  is_public boolean;
begin
  if parts[1] is null then return false; end if;

  -- admin working state is never public
  if parts[1] = 'comp' and parts[3] = 'admin' then
    return public.can_manage_competition(public.db_competition_for(p_tenant, parts));
  end if;

  if public.is_member(p_tenant) then return true; end if;

  select public_view into is_public from public.tenants where id = p_tenant;
  return coalesce(is_public, false);
end $fn$;

create or replace function public.db_can_write(p_tenant uuid, p_path text) returns boolean
  language plpgsql stable security definer set search_path = public as $fn$
declare parts text[] := public.db_split(p_path);
begin
  if parts[1] is null then return false; end if;
  if public.is_platform_admin() then return true; end if;
  if not public.is_member(p_tenant) then return false; end if;

  -- competition state: owner or that competition's manager
  if parts[1] = 'comp' then
    return public.can_manage_competition(public.db_competition_for(p_tenant, parts));
  end if;

  -- a player claiming or releasing their team
  if parts[1] = 'claims' and coalesce(array_length(parts, 1), 0) between 2 and 3
    then return true; end if;

  -- reactions on a clip, never the clip record itself
  if parts[1] = 'highlights'
     and coalesce(array_length(parts, 1), 0) >= 4
     and parts[4] in ('likes', 'dislikes', 'views', 'comments')
    then return true; end if;

  -- everything else is owner/manager territory
  return public.my_role(p_tenant) in ('owner', 'manager');
end $fn$;

-- Rejects replacing a populated competition document with an empty one. The
-- single-tenant version of this app lost a live season exactly that way, when a
-- device with empty local storage saved its defaults over the real record.
create or replace function public.db_doc_weight(d jsonb) returns int
  language sql immutable as $fn$
  select
    (case when jsonb_typeof(d -> 'teams')     = 'array'
          then jsonb_array_length(d -> 'teams')     else 0 end)
  + (case when jsonb_typeof(d -> 'matchdays') = 'array'
          then jsonb_array_length(d -> 'matchdays') else 0 end)
  + (case when jsonb_typeof(d -> 'fixtures')  = 'array'
          then jsonb_array_length(d -> 'fixtures')  else 0 end)
  + (case when jsonb_typeof(d -> 'groups')    = 'object'
          then (select count(*)::int from jsonb_object_keys(d -> 'groups')) else 0 end)
$fn$;

create or replace function public.db_get(p_tenant uuid, p_path text) returns jsonb
  language plpgsql stable security definer set search_path = public as $fn$
declare parts text[]; rest text[]; doc jsonb;
begin
  if not public.db_can_read(p_tenant, p_path) then
    raise exception 'permission denied reading %', p_path using errcode = '42501';
  end if;
  parts := public.db_split(p_path);
  rest  := parts[2:coalesce(array_length(parts, 1), 1)];
  select d.data into doc from public.documents d
   where d.tenant_id = p_tenant and d.path = parts[1];
  if doc is null then return null; end if;
  if coalesce(array_length(rest, 1), 0) = 0 then return doc; end if;
  return doc #> rest;
end $fn$;

create or replace function public.db_get_many(p_tenant uuid, p_paths text[]) returns jsonb
  language plpgsql stable security definer set search_path = public as $fn$
declare result jsonb := '{}'::jsonb; p text;
begin
  foreach p in array p_paths loop
    result := jsonb_set(result, array[p],
                        coalesce(public.db_get(p_tenant, p), 'null'::jsonb), true);
  end loop;
  return result;
end $fn$;

create or replace function public.db_set(p_tenant uuid, p_path text, p_data jsonb)
  returns jsonb language plpgsql volatile security definer set search_path = public as $fn$
declare parts text[]; rest text[]; cur jsonb; nxt jsonb; root text;
begin
  if not public.db_can_write(p_tenant, p_path) then
    raise exception 'permission denied writing %', p_path using errcode = '42501';
  end if;
  parts := public.db_split(p_path);
  root  := parts[1];
  rest  := parts[2:coalesce(array_length(parts, 1), 1)];

  select d.data into cur from public.documents d
   where d.tenant_id = p_tenant and d.path = root for update;

  if coalesce(array_length(rest, 1), 0) = 0 then
    if root = 'comp' and cur is not null
       and public.db_doc_weight(cur) > 0 and public.db_doc_weight(p_data) = 0 then
      raise exception 'refusing to overwrite populated % with an empty document', p_path
        using errcode = '23514',
              hint = 'Load from the server before saving; local state looks uninitialised.';
    end if;
    nxt := p_data;
  else
    nxt := jsonb_set(coalesce(cur, '{}'::jsonb), rest, p_data, true);
  end if;

  insert into public.documents (tenant_id, path, data, updated_at, updated_by)
  values (p_tenant, root, nxt, now(), auth.uid())
  on conflict (tenant_id, path) do update
    set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by;

  return nxt;
end $fn$;

create or replace function public.db_update(p_tenant uuid, p_path text, p_data jsonb)
  returns jsonb language plpgsql volatile security definer set search_path = public as $fn$
declare parts text[]; rest text[]; cur jsonb; base jsonb; nxt jsonb; root text;
begin
  if not public.db_can_write(p_tenant, p_path) then
    raise exception 'permission denied writing %', p_path using errcode = '42501';
  end if;
  parts := public.db_split(p_path);
  root  := parts[1];
  rest  := parts[2:coalesce(array_length(parts, 1), 1)];

  select d.data into cur from public.documents d
   where d.tenant_id = p_tenant and d.path = root for update;

  if coalesce(array_length(rest, 1), 0) = 0 then
    nxt := coalesce(cur, '{}'::jsonb) || p_data;
  else
    base := coalesce(coalesce(cur, '{}'::jsonb) #> rest, '{}'::jsonb);
    nxt  := jsonb_set(coalesce(cur, '{}'::jsonb), rest, base || p_data, true);
  end if;

  insert into public.documents (tenant_id, path, data, updated_at, updated_by)
  values (p_tenant, root, nxt, now(), auth.uid())
  on conflict (tenant_id, path) do update
    set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by;

  return nxt;
end $fn$;

create or replace function public.db_delete(p_tenant uuid, p_path text) returns void
  language plpgsql volatile security definer set search_path = public as $fn$
declare parts text[]; rest text[]; cur jsonb; root text;
begin
  if not public.db_can_write(p_tenant, p_path) then
    raise exception 'permission denied writing %', p_path using errcode = '42501';
  end if;
  parts := public.db_split(p_path);
  root  := parts[1];
  rest  := parts[2:coalesce(array_length(parts, 1), 1)];

  if coalesce(array_length(rest, 1), 0) = 0 then
    delete from public.documents where tenant_id = p_tenant and path = root;
    return;
  end if;

  select d.data into cur from public.documents d
   where d.tenant_id = p_tenant and d.path = root for update;
  if cur is null then return; end if;

  update public.documents
     set data = cur #- rest, updated_at = now(), updated_by = auth.uid()
   where tenant_id = p_tenant and path = root;
end $fn$;

-- ---------------------------------------------------------------------------
--  5. Registration
-- ---------------------------------------------------------------------------

/**
 * Create a league and make the caller its owner, atomically.
 * Called straight after email verification.
 */
create or replace function public.create_tenant(
  p_name text, p_slug text, p_game_type text
) returns uuid
  language plpgsql volatile security definer set search_path = public as $fn$
declare new_id uuid; clean_slug text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;

  clean_slug := lower(regexp_replace(coalesce(nullif(p_slug, ''), p_name),
                                     '[^a-zA-Z0-9]+', '-', 'g'));
  clean_slug := trim(both '-' from clean_slug);
  if clean_slug = '' then
    raise exception 'league name must contain letters or numbers';
  end if;
  if exists (select 1 from public.tenants where slug = clean_slug) then
    raise exception 'that league address is already taken' using errcode = '23505';
  end if;

  insert into public.tenants (slug, name, game_type, owner_id)
  values (clean_slug, p_name, coalesce(nullif(p_game_type, ''), 'other'), auth.uid())
  returning id into new_id;

  insert into public.memberships (user_id, tenant_id, role)
  values (auth.uid(), new_id, 'owner');

  return new_id;
end $fn$;

/**
 * Flip a membership from 'invited' to 'active' on first sign-in, so the console
 * shows which players have actually picked up their account.
 */
create or replace function public.touch_membership(p_tenant uuid) returns void
  language sql volatile security definer set search_path = public as $fn$
  update public.memberships
     set status = 'active'
   where user_id = auth.uid() and tenant_id = p_tenant and status = 'invited'
$fn$;

/** Everything the app needs on boot: who am I, and what can I see. */
create or replace function public.my_context()
  returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'is_platform_admin', public.is_platform_admin(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenant_id',   t.id,
        'tenant_name', t.name,
        'tenant_slug', t.slug,
        'game_type',   t.game_type,
        'role',        m.role,
        'team',        m.team,
        'status',      m.status,
        'competition_ids', m.competition_ids
      ))
      from public.memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.user_id = auth.uid()
    ), '[]'::jsonb)
  )
$fn$;

-- ---------------------------------------------------------------------------
--  6. Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant execute on function public.db_get(uuid, text)              to anon, authenticated;
grant execute on function public.db_get_many(uuid, text[])       to anon, authenticated;
grant execute on function public.db_set(uuid, text, jsonb)       to authenticated;
grant execute on function public.db_update(uuid, text, jsonb)    to authenticated;
grant execute on function public.db_delete(uuid, text)           to authenticated;
grant execute on function public.my_context()                    to anon, authenticated;
grant execute on function public.create_tenant(text, text, text) to authenticated;
grant execute on function public.touch_membership(uuid)          to authenticated;

grant select              on public.tenants         to anon, authenticated;
grant update              on public.tenants         to authenticated;
grant select              on public.competitions    to anon, authenticated;
grant insert, update, delete on public.competitions to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;
grant select              on public.platform_admins to authenticated;
grant select, insert, update on public.push_tokens  to anon, authenticated;
