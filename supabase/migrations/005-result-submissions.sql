-- ============================================================================
--  005 - players submit results, admins verify them
--
--  A player finishes a match, opens the fixture in the app, and uploads a
--  screenshot with the score they believe it was. The organiser sees it against
--  that exact fixture, checks the image, and confirms or corrects the score.
--
--  The player's claim is never applied on its own. Accepting is what writes the
--  score, and only an organiser can accept - otherwise the screenshot is
--  decoration and anyone could set their own results.
--
--  Safe to re-run.
-- ============================================================================

create table if not exists public.result_submissions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id)      on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,

  -- Identifies the fixture inside the competition document, e.g.
  -- 'md:3/m:12' for a league matchday, 'grp:A/m:4' or 'ko:1/m:0' for a cup.
  -- A string rather than a foreign key because fixtures live in JSONB, and
  -- regenerating a schedule replaces them wholesale.
  match_ref      text not null,

  submitted_by   uuid references auth.users(id) on delete set null,
  team           text,
  claimed_home   int,
  claimed_away   int,
  note           text,
  image_paths    text[] not null default '{}',

  status         text not null default 'pending'
                 check (status in ('pending','accepted','rejected')),
  review_note    text,
  reviewed_by    uuid references auth.users(id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists submissions_tenant_idx  on public.result_submissions(tenant_id);
create index if not exists submissions_pending_idx on public.result_submissions(competition_id, status);

-- One live submission per team per fixture. Without this a player can upload
-- the same result repeatedly and bury the organiser in duplicates; a rejected
-- one does not block a corrected resubmission.
create unique index if not exists submissions_one_pending
  on public.result_submissions(competition_id, match_ref, lower(coalesce(team, '')))
  where status = 'pending';

alter table public.result_submissions enable row level security;

-- ---------------------------------------------------------------------------
--  Who may do what
-- ---------------------------------------------------------------------------

/** Owner of the league, or a manager assigned to this competition. */
create or replace function public.can_review(p_competition uuid) returns boolean
  language sql stable security definer set search_path = public as $fn$
  select public.can_manage_competition(p_competition)
$fn$;

drop policy if exists "members submit results" on public.result_submissions;
create policy "members submit results" on public.result_submissions
  for insert to authenticated
  with check (
    public.is_member(tenant_id)
    and submitted_by = auth.uid()
    -- A player may only submit as themselves, for the team on their own
    -- membership. Otherwise anyone could file a result under another club.
    and exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.tenant_id = result_submissions.tenant_id
        and (m.role in ('owner','manager') or lower(m.team) = lower(result_submissions.team))
    )
  );

drop policy if exists "see your own, or all if you review" on public.result_submissions;
create policy "see your own, or all if you review" on public.result_submissions
  for select to authenticated
  using (submitted_by = auth.uid() or public.can_review(competition_id));

drop policy if exists "reviewers decide" on public.result_submissions;
create policy "reviewers decide" on public.result_submissions
  for update to authenticated
  using (public.can_review(competition_id)) with check (public.can_review(competition_id));

drop policy if exists "reviewers clear submissions" on public.result_submissions;
create policy "reviewers clear submissions" on public.result_submissions
  for delete to authenticated
  using (public.can_review(competition_id));

grant select, insert, update, delete on public.result_submissions to authenticated;

-- ---------------------------------------------------------------------------
--  Storage: match-results
--
--  Private bucket. Screenshots often show a player's own game profile, so they
--  are readable only by that league - never by a URL someone happens to guess.
--  Paths are <tenant_id>/<competition_id>/<file>, and the first segment is
--  checked against the caller's leagues.
-- ---------------------------------------------------------------------------

drop policy if exists "members upload results" on storage.objects;
create policy "members upload results" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'match-results'
    and (storage.foldername(name))[1]::uuid = any(public.my_tenant_ids())
  );

drop policy if exists "league reads its results" on storage.objects;
create policy "league reads its results" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'match-results'
    and (storage.foldername(name))[1]::uuid = any(public.my_tenant_ids())
  );

drop policy if exists "league removes its results" on storage.objects;
create policy "league removes its results" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'match-results'
    and (storage.foldername(name))[1]::uuid = any(public.my_tenant_ids())
  );

-- ---------------------------------------------------------------------------
--  How many are waiting - so the console can badge it without pulling rows
-- ---------------------------------------------------------------------------

create or replace function public.pending_result_count(p_tenant uuid) returns int
  language sql stable security definer set search_path = public as $fn$
  select count(*)::int
  from public.result_submissions s
  where s.tenant_id = p_tenant
    and s.status = 'pending'
    and public.can_review(s.competition_id)
$fn$;

grant execute on function public.can_review(uuid)            to authenticated;
grant execute on function public.pending_result_count(uuid)  to authenticated;
