# Migrations

`../schema.sql` is the **full schema**, and it has now been applied. Treat it as
a reference for what the database should look like — not as something to re-run.

From here, every change ships as its own numbered file in this folder:

```
001-rename-platform.sql
002-add-fixtures-index.sql
```

Run only the new file in the Supabase SQL editor. Never re-run `schema.sql`:
section 0 drops the v1 tables, and re-running it against a live database is a
good way to lose a season.

## Conventions

- **Number them in order.** The prefix is the order they must be applied in.
- **Make each one re-runnable.** `create ... if not exists`,
  `drop policy if exists` before `create policy`, `create or replace function`.
  Applying the same file twice should be a no-op, not an error.
- **`alter table ... add column if not exists`**, never `create table if not exists`
  for a table that already exists. The latter silently does nothing when the
  table is present in an older shape, and the failure surfaces later at the first
  reference to the missing column — that is exactly what broke the v2 rollout
  (v1's `push_tokens` had no `tenant_id`).
- **Say what changed and why** in a header comment.

## Applied

| File | What it did |
|---|---|
| `../schema.sql` | Initial multi-tenant schema: tenants, competitions, memberships, documents, push_tokens |
