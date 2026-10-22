-- openGym persistence for Supabase Postgres (and any plain Postgres).
--
-- The browser never talks to these tables. The API connects as the database
-- owner through DATABASE_URL (the Supabase pooler URI) and bypasses row level
-- security. RLS is on, with an explicit deny for the Data API roles, so the
-- anon and authenticated keys cannot read or write. Do not add a policy that
-- opens these tables to the client, and do not put the service role key in
-- the frontend.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

create table if not exists app_kv (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Whole JSON documents: db, db.bak, state:<uid>, coach, coach-user:<uid>, coach-auth:<uid>.
create table if not exists documents (
  id text primary key,
  body text not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists challenges (
  id text primary key,
  payload jsonb not null,
  exp bigint not null
);
create index if not exists challenges_exp_idx on challenges (exp);

create table if not exists pairings (
  code text primary key,
  uid text not null,
  exp bigint not null
);
create index if not exists pairings_uid_idx on pairings (uid);

create table if not exists presence (
  uid text primary key,
  payload jsonb not null,
  updated_at bigint not null
);

create table if not exists rest_timers (
  key text primary key,
  user_id text not null,
  device_id text,
  lang text,
  fire_at bigint not null
);
create index if not exists rest_timers_fire_idx on rest_timers (fire_at);

create table if not exists audit_events (
  id bigserial primary key,
  rec jsonb not null
);

create table if not exists media_objects (
  uid text not null,
  hash text not null,
  ext text not null,
  mime text not null,
  size bigint not null,
  storage_path text,
  bytes bytea,
  created_at timestamptz not null default now(),
  primary key (uid, hash)
);

create table if not exists media_gc (
  uid text not null,
  hash text not null,
  unreferenced_since bigint not null,
  primary key (uid, hash)
);

create table if not exists media_pending (
  uid text not null,
  hash text not null,
  mime text not null,
  size bigint not null,
  storage_path text,
  exp bigint not null,
  primary key (uid, hash)
);

create table if not exists sync_parts (
  upload_id text not null,
  idx integer not null,
  total integer not null,
  uid text not null,
  gzip boolean not null default false,
  data bytea not null,
  created_at timestamptz not null default now(),
  primary key (upload_id, idx)
);
create index if not exists sync_parts_created_idx on sync_parts (created_at);

-- Explicit deny for the Data API. The table owner (the server's connection)
-- bypasses RLS; do not FORCE ROW LEVEL SECURITY or the API would lock itself out.
do $$
declare t text;
begin
  foreach t in array array[
    'app_kv','documents','challenges','pairings','presence','rest_timers',
    'audit_events','media_objects','media_gc','media_pending','sync_parts'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public, anon, authenticated', t);
    execute format('drop policy if exists opengym_no_client on %I', t);
    execute format(
      'create policy opengym_no_client on %I for all to anon, authenticated using (false) with check (false)',
      t
    );
  end loop;
end $$;

revoke all on sequence audit_events_id_seq from public, anon, authenticated;
