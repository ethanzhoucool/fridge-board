-- Fridge: one shared board for a small group. Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- People on the board. A member can exist (from a scanned board) before anyone claims it by signing in.
create table members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  user_id uuid unique references auth.users on delete set null,
  avatar_url text,
  created_at timestamptz not null default now()
);
create unique index members_name_key on members (lower(name));

create table weeks (
  id bigint generated always as identity primary key,
  number int not null unique,
  starts_on date not null default current_date,
  group_goal text,
  group_done boolean not null default false,
  fun jsonb not null default '[]',      -- [{label, done}]
  charity text,
  rules jsonb not null default '[]',    -- [text]
  created_at timestamptz not null default now()
);

create table goals (
  id bigint generated always as identity primary key,
  week_id bigint not null references weeks on delete cascade,
  member_id uuid not null references members on delete cascade,
  label text not null,
  note text,
  target int not null default 1 check (target between 1 and 30),
  done int not null default 0 check (done >= 0),
  position int not null default 0
);
create index goals_week_idx on goals (week_id);

create table posts (
  id bigint generated always as identity primary key,
  week_id bigint not null references weeks on delete cascade,
  member_id uuid not null references members on delete cascade,
  kind text not null check (kind in ('text', 'voice', 'photo')),
  body text,
  media_path text,
  duration int,
  goal_id bigint references goals on delete set null,
  created_at timestamptz not null default now()
);
create index posts_week_idx on posts (week_id, created_at desc);

-- Private settings, only reachable through the functions below.
create table app_config (key text primary key, value text not null);
insert into app_config values ('join_code', encode(gen_random_bytes(6), 'hex'));

create function is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid());
$$;

create function my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from members where user_id = auth.uid();
$$;

-- True until the first person signs in; that person can join without an invite code.
create function needs_setup() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from members where user_id is not null);
$$;

create function code_ok(code text) returns boolean
language sql stable security definer set search_path = public as $$
  select needs_setup() or code = (select value from app_config where key = 'join_code');
$$;

-- Names a new person can claim when they open the invite link.
create function open_names(code text) returns setof text
language sql stable security definer set search_path = public as $$
  select name from members where user_id is null and code_ok(code) order by name;
$$;

create function join_group(code text, member_name text) returns members
language plpgsql security definer set search_path = public as $$
declare m members;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not coalesce(code_ok(code), false) then
    raise exception 'That invite link is not valid';
  end if;
  select * into m from members where user_id = auth.uid();
  if found then return m; end if;
  select * into m from members where lower(name) = lower(trim(member_name)) for update;
  if found then
    if m.user_id is not null then raise exception 'That name is already taken'; end if;
    update members set user_id = auth.uid(), avatar_url = auth.jwt() -> 'user_metadata' ->> 'avatar_url'
      where id = m.id returning * into m;
  else
    insert into members (name, user_id, avatar_url)
      values (trim(member_name), auth.uid(), auth.jwt() -> 'user_metadata' ->> 'avatar_url')
      returning * into m;
  end if;
  return m;
end $$;

create function join_code() returns text
language sql stable security definer set search_path = public as $$
  select value from app_config where key = 'join_code' and is_member();
$$;

revoke execute on function join_group(text, text) from anon;
revoke execute on function join_code() from anon;

alter table members enable row level security;
alter table weeks enable row level security;
alter table goals enable row level security;
alter table posts enable row level security;
alter table app_config enable row level security;

create policy "members read" on members for select using (is_member());
create policy "members add" on members for insert with check (is_member());
create policy "members edit" on members for update using (is_member());

create policy "weeks all" on weeks for all using (is_member()) with check (is_member());
create policy "goals all" on goals for all using (is_member()) with check (is_member());

create policy "posts read" on posts for select using (is_member());
create policy "posts add" on posts for insert with check (member_id = my_member_id());
create policy "posts delete own" on posts for delete using (member_id = my_member_id());

-- Media: private bucket, members can read everything and manage their own uploads.
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 15728640);

create policy "media read" on storage.objects for select
  using (bucket_id = 'media' and public.is_member());
create policy "media add" on storage.objects for insert
  with check (bucket_id = 'media' and public.is_member());
create policy "media delete own" on storage.objects for delete
  using (bucket_id = 'media' and owner = auth.uid());

alter publication supabase_realtime add table posts, goals, weeks;
