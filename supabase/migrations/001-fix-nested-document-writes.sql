-- ============================================================================
--  001 - fix nested document writes
--
--  Bug: saving comp/<key>/admin silently wrote nothing.
--
--  db_set did jsonb_set(target, '{<key>,admin}', data, true). Postgres only
--  creates the LAST element of the path when create_missing is true; it will
--  not create intermediate levels. With `<key>` absent from an empty document,
--  jsonb_set returned the target unchanged and raised nothing, so the client
--  reported "Saved" and the data was gone on the next load.
--
--  Two changes:
--    1. jsonb_deep_set() builds missing intermediate objects.
--    2. Each competition becomes its own row (root 'comp/<key>' rather than a
--       shared 'comp' row), so two admins editing different competitions no
--       longer contend on one record and no single row grows unbounded.
--
--  Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  1. Deep set that creates intermediates
-- ---------------------------------------------------------------------------

create or replace function public.jsonb_deep_set(
  target jsonb, path text[], val jsonb
) returns jsonb
  language plpgsql immutable as $fn$
declare
  head  text;
  child jsonb;
begin
  if target is null then target := '{}'::jsonb; end if;
  if coalesce(array_length(path, 1), 0) = 0 then return val; end if;

  -- One level left: jsonb_set creates it for us.
  if array_length(path, 1) = 1 then
    return jsonb_set(target, path, val, true);
  end if;

  head  := path[1];
  child := target -> head;
  -- Missing, or holding a scalar where an object is needed: start fresh so the
  -- rest of the path has somewhere to live.
  if child is null or jsonb_typeof(child) not in ('object', 'array') then
    child := '{}'::jsonb;
  end if;

  return jsonb_set(
    target,
    array[head],
    public.jsonb_deep_set(child, path[2:array_length(path, 1)], val),
    true
  );
end $fn$;

-- ---------------------------------------------------------------------------
--  2. Which part of a path identifies the row
--     Competitions get a row each; everything else keys on its first segment.
-- ---------------------------------------------------------------------------

create or replace function public.db_root(parts text[]) returns text
  language sql immutable as $fn$
  select case
    when parts[1] = 'comp' and parts[2] is not null then parts[1] || '/' || parts[2]
    else parts[1]
  end
$fn$;

create or replace function public.db_rest(parts text[]) returns text[]
  language sql immutable as $fn$
  select case
    when parts[1] = 'comp' and parts[2] is not null
      then parts[3:coalesce(array_length(parts, 1), 2)]
    else parts[2:coalesce(array_length(parts, 1), 1)]
  end
$fn$;

-- ---------------------------------------------------------------------------
--  3. Rebuild the accessors on top of them
-- ---------------------------------------------------------------------------

create or replace function public.db_get(p_tenant uuid, p_path text) returns jsonb
  language plpgsql stable security definer set search_path = public as $fn$
declare parts text[]; rest text[]; doc jsonb;
begin
  if not public.db_can_read(p_tenant, p_path) then
    raise exception 'permission denied reading %', p_path using errcode = '42501';
  end if;
  parts := public.db_split(p_path);
  rest  := public.db_rest(parts);
  select d.data into doc from public.documents d
   where d.tenant_id = p_tenant and d.path = public.db_root(parts);
  if doc is null then return null; end if;
  if coalesce(array_length(rest, 1), 0) = 0 then return doc; end if;
  return doc #> rest;
end $fn$;

create or replace function public.db_set(p_tenant uuid, p_path text, p_data jsonb)
  returns jsonb language plpgsql volatile security definer set search_path = public as $fn$
declare parts text[]; rest text[]; cur jsonb; nxt jsonb; root text;
begin
  if not public.db_can_write(p_tenant, p_path) then
    raise exception 'permission denied writing %', p_path using errcode = '42501';
  end if;
  parts := public.db_split(p_path);
  root  := public.db_root(parts);
  rest  := public.db_rest(parts);

  select d.data into cur from public.documents d
   where d.tenant_id = p_tenant and d.path = root for update;

  if coalesce(array_length(rest, 1), 0) = 0 then
    if parts[1] = 'comp' and cur is not null
       and public.db_doc_weight(cur) > 0 and public.db_doc_weight(p_data) = 0 then
      raise exception 'refusing to overwrite populated % with an empty document', p_path
        using errcode = '23514',
              hint = 'Load from the server before saving; local state looks uninitialised.';
    end if;
    nxt := p_data;
  else
    nxt := public.jsonb_deep_set(coalesce(cur, '{}'::jsonb), rest, p_data);
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
  root  := public.db_root(parts);
  rest  := public.db_rest(parts);

  select d.data into cur from public.documents d
   where d.tenant_id = p_tenant and d.path = root for update;

  if coalesce(array_length(rest, 1), 0) = 0 then
    nxt := coalesce(cur, '{}'::jsonb) || p_data;
  else
    base := coalesce(coalesce(cur, '{}'::jsonb) #> rest, '{}'::jsonb);
    if jsonb_typeof(base) <> 'object' then base := '{}'::jsonb; end if;
    nxt := public.jsonb_deep_set(coalesce(cur, '{}'::jsonb), rest, base || p_data);
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
  root  := public.db_root(parts);
  rest  := public.db_rest(parts);

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
--  4. Clear the shared 'comp' rows the old layout produced
--     They only ever held {} - the writes that should have filled them were
--     the ones being dropped.
-- ---------------------------------------------------------------------------

delete from public.documents where path = 'comp' and data = '{}'::jsonb;

grant execute on function public.jsonb_deep_set(jsonb, text[], jsonb) to authenticated;
grant execute on function public.db_root(text[])                      to anon, authenticated;
grant execute on function public.db_rest(text[])                      to anon, authenticated;
