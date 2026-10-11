-- SwingDelay schema. Run this once in the Supabase SQL editor.

-- ============ tables ============
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null check (role in ('coach','hitter')),
  name text,
  created_at timestamptz default now()
);

create table if not exists hitters (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references profiles(id) on delete cascade,
  user_id uuid references profiles(id) on delete set null,
  name text not null,
  bats text,
  invite_code text unique not null,
  created_at timestamptz default now()
);

create table if not exists swings (
  id uuid primary key default gen_random_uuid(),
  hitter_id uuid not null references hitters(id) on delete cascade,
  video_path text not null,
  duration_s numeric,
  clip_source text default 'manual',
  favorite boolean default false,
  note text,
  taken_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  swing_id uuid not null references swings(id) on delete cascade,
  tag text not null,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- ============ storage bucket ============
insert into storage.buckets (id, name, public)
values ('swing-videos', 'swing-videos', false)
on conflict (id) do nothing;

-- ============ helpers ============
create or replace function is_coach()
returns boolean language sql security definer stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'coach');
$$;

-- hitter claims an invite code (links their login to the hitter row)
create or replace function claim_hitter(p_code text)
returns uuid language plpgsql security definer as $$
declare hid uuid;
begin
  select id into hid from hitters
  where invite_code = p_code and user_id is null;
  if hid is null then
    raise exception 'Invalid or already-claimed code';
  end if;
  update hitters set user_id = auth.uid() where id = hid;
  return hid;
end $$;

-- auto-create profile row on signup (role/name come from signup metadata)
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, role, name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'role', 'coach'),
          coalesce(new.raw_user_meta_data->>'name', ''));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============ RLS ============
alter table profiles enable row level security;
drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles for select using (auth.uid() = id);
drop policy if exists "update own profile" on profiles for update using (auth.uid() = id);

alter table hitters enable row level security;
drop policy if exists "coach reads own hitters" on hitters;
create policy "coach reads own hitters" on hitters for select using (coach_id = auth.uid());
drop policy if exists "hitter reads own row" on hitters;
create policy "hitter reads own row" on hitters for select using (user_id = auth.uid());
drop policy if exists "coach inserts hitters" on hitters;
create policy "coach inserts hitters" on hitters for insert with check (is_coach() and coach_id = auth.uid());
drop policy if exists "coach manages own hitters" on hitters;
create policy "coach manages own hitters" on hitters for update using (coach_id = auth.uid());
drop policy if exists "coach deletes own hitters" on hitters;
create policy "coach deletes own hitters" on hitters for delete using (coach_id = auth.uid());

alter table swings enable row level security;
drop policy if exists "read swings" on swings;
create policy "read swings" on swings for select using (
  exists (select 1 from hitters h where h.id = swings.hitter_id
          and (h.coach_id = auth.uid() or h.user_id = auth.uid())));
drop policy if exists "insert swings" on swings;
create policy "insert swings" on swings for insert with check (
  exists (select 1 from hitters h where h.id = hitter_id
          and (h.coach_id = auth.uid() or h.user_id = auth.uid())));
drop policy if exists "update swings" on swings;
create policy "update swings" on swings for update using (
  exists (select 1 from hitters h where h.id = swings.hitter_id
          and (h.coach_id = auth.uid() or h.user_id = auth.uid())));
drop policy if exists "delete swings" on swings;
create policy "delete swings" on swings for delete using (
  exists (select 1 from hitters h where h.id = swings.hitter_id
          and (h.coach_id = auth.uid() or h.user_id = auth.uid())));

alter table tags enable row level security;
drop policy if exists "read tags" on tags;
create policy "read tags" on tags for select using (
  exists (select 1 from swings s join hitters h on h.id = s.hitter_id
          where s.id = tags.swing_id and (h.coach_id = auth.uid() or h.user_id = auth.uid())));
drop policy if exists "insert tags" on tags;
create policy "insert tags" on tags for insert with check (
  exists (select 1 from swings s join hitters h on h.id = s.hitter_id
          where s.id = swing_id and (h.coach_id = auth.uid() or h.user_id = auth.uid())));
drop policy if exists "delete tags" on tags;
create policy "delete tags" on tags for delete using (
  exists (select 1 from swings s join hitters h on h.id = s.hitter_id
          where s.id = tags.swing_id and (h.coach_id = auth.uid() or h.user_id = auth.uid())));

-- ============ storage policies ============
drop policy if exists "upload swing videos" on storage.objects;
create policy "upload swing videos" on storage.objects for insert with check (
  bucket_id = 'swing-videos' and (
    is_coach()
    or exists (select 1 from hitters h where h.user_id = auth.uid()
               and h.id::text = split_part(name, '/', 2))
  ));
drop policy if exists "read swing videos" on storage.objects;
create policy "read swing videos" on storage.objects for select using (
  bucket_id = 'swing-videos' and exists (
    select 1 from swings s join hitters h on h.id = s.hitter_id
    where s.video_path = name and (h.coach_id = auth.uid() or h.user_id = auth.uid())));
drop policy if exists "delete swing videos" on storage.objects;
create policy "delete swing videos" on storage.objects for delete using (
  bucket_id = 'swing-videos' and (
    is_coach()
    or exists (select 1 from hitters h where h.user_id = auth.uid()
               and h.id::text = split_part(name, '/', 2))
  ));
