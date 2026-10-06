-- Run once in a new Supabase project (SQL Editor). Never use service_role in
-- the frontend. The backend also uses the signed-in user's JWT, enforcing RLS.
begin;
create table public.collab_pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) <= 200),
  created_at timestamptz not null default now()
);
create table public.collab_members (
  page_id uuid not null references public.collab_pages(id) on delete cascade,
  email text not null check (email = lower(email) and length(email) <= 254),
  role text not null check (role in ('viewer', 'editor')),
  primary key (page_id, email)
);
create table public.collab_updates (
  id bigint generated always as identity primary key,
  page_id uuid not null references public.collab_pages(id) on delete cascade,
  data text not null check (length(data) <= 2097152),
  created_at timestamptz not null default now()
);
create index collab_updates_page_id_id on public.collab_updates(page_id, id);

-- Security-definer helpers avoid recursive policies; bound to current auth.uid.
create function public.collab_role(target uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p.owner_id = auth.uid() then 'owner' else (
    select m.role from public.collab_members m
    where m.page_id = p.id and m.email = lower(auth.jwt()->>'email')
  ) end from public.collab_pages p where p.id = target
$$;
revoke all on function public.collab_role(uuid) from public;
grant execute on function public.collab_role(uuid) to authenticated;

alter table public.collab_pages enable row level security;
alter table public.collab_members enable row level security;
alter table public.collab_updates enable row level security;
create policy pages_read on public.collab_pages for select to authenticated using (public.collab_role(id) is not null);
create policy pages_create on public.collab_pages for insert to authenticated with check (owner_id = auth.uid());
create policy pages_update on public.collab_pages for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy pages_delete on public.collab_pages for delete to authenticated using (owner_id = auth.uid());
create policy members_read on public.collab_members for select to authenticated using (public.collab_role(page_id) = 'owner' or email = lower(auth.jwt()->>'email'));
create policy members_create on public.collab_members for insert to authenticated with check (public.collab_role(page_id) = 'owner');
create policy members_update on public.collab_members for update to authenticated using (public.collab_role(page_id) = 'owner') with check (public.collab_role(page_id) = 'owner');
create policy members_delete on public.collab_members for delete to authenticated using (public.collab_role(page_id) = 'owner');
create policy updates_read on public.collab_updates for select to authenticated using (public.collab_role(page_id) is not null);
create policy updates_create on public.collab_updates for insert to authenticated with check (public.collab_role(page_id) in ('owner', 'editor'));

grant select, insert, update, delete on public.collab_pages, public.collab_members to authenticated;
grant select, insert on public.collab_updates to authenticated;
grant usage, select on sequence public.collab_updates_id_seq to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 12582912, array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
-- Safe path parser: malformed names cannot provoke a uuid cast error.
create function public.collab_storage_page(path text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return split_part(path, '/', 1)::uuid;
exception when invalid_text_representation then return null;
end $$;
create policy images_read on storage.objects for select to authenticated using (
  bucket_id = 'note-images' and public.collab_role(public.collab_storage_page(name)) is not null
);
create policy images_create on storage.objects for insert to authenticated with check (
  bucket_id = 'note-images' and public.collab_role(public.collab_storage_page(name)) in ('owner', 'editor')
);
create policy images_update on storage.objects for update to authenticated using (
  bucket_id = 'note-images' and public.collab_role(public.collab_storage_page(name)) in ('owner', 'editor')
) with check (
  bucket_id = 'note-images' and public.collab_role(public.collab_storage_page(name)) in ('owner', 'editor')
);
commit;
