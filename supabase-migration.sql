alter table public.destinations
  add column if not exists address text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists is_published boolean;

alter table public.destinations
  alter column is_published set default true;

update public.destinations
set is_published = true
where is_published is null;

create table if not exists public.place_reviews (
  id uuid primary key default gen_random_uuid(),
  destination_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text not null check (char_length(comment) between 1 and 1000),
  created_at timestamptz not null default now()
);

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'place_reviews'
      and con.contype = 'u'
      and pg_get_constraintdef(con.oid) ilike '%UNIQUE (destination_id, user_id)%'
  loop
    execute format('alter table public.place_reviews drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table public.place_reviews enable row level security;
drop policy if exists "Published reviews are readable" on public.place_reviews;
create policy "Published reviews are readable" on public.place_reviews
  for select using (true);
drop policy if exists "Users can create their own review" on public.place_reviews;
create policy "Users can create their own review" on public.place_reviews
  for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own review" on public.place_reviews;
create policy "Users can update their own review" on public.place_reviews
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can delete their own review" on public.place_reviews;
create policy "Users can delete their own review" on public.place_reviews
  for delete using (auth.uid() = user_id);
drop policy if exists "Admins can delete reviews" on public.place_reviews;
create policy "Admins can delete reviews" on public.place_reviews
  for delete using (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

insert into storage.buckets (id, name, public)
values ('place-images', 'place-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public place images are readable" on storage.objects;
create policy "Public place images are readable" on storage.objects
  for select using (bucket_id = 'place-images');
drop policy if exists "Authenticated users can upload place images" on storage.objects;
create policy "Authenticated users can upload place images" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'place-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );