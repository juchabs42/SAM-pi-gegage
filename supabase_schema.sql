-- SAM Piégeage — schéma Supabase
-- À exécuter une seule fois dans Supabase > SQL Editor.
--
-- Principe :
-- - tous les utilisateurs authentifiés peuvent voir les parcelles et relevés ;
-- - chacun peut créer des parcelles et des relevés ;
-- - chacun ne peut modifier/supprimer que les lignes qu'il a créées.
--
-- IMPORTANT : le site utilise uniquement la clé publique "anon".
-- Ne jamais placer la clé "service_role" dans un site statique.

create extension if not exists pgcrypto;

create table if not exists public.parcels (
  id uuid primary key default gen_random_uuid(),
  exploitation text not null check (length(trim(exploitation)) > 0),
  name text not null check (length(trim(name)) > 0),
  variety text not null check (length(trim(variety)) > 0),
  area_ha numeric(10, 3) not null check (area_ha >= 0),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint parcels_exploitation_name_unique unique (exploitation, name)
);

create table if not exists public.trap_observations (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null references public.parcels(id) on delete cascade,
  pest text not null check (length(trim(pest)) > 0),
  observed_on date not null,
  captures integer not null check (captures >= 0),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists trap_observations_lookup_idx
  on public.trap_observations (parcel_id, pest, observed_on);

create index if not exists trap_observations_created_at_idx
  on public.trap_observations (created_at);

alter table public.parcels enable row level security;
alter table public.trap_observations enable row level security;

drop policy if exists "Authenticated users can read parcels" on public.parcels;
create policy "Authenticated users can read parcels"
  on public.parcels
  for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can create parcels" on public.parcels;
create policy "Authenticated users can create parcels"
  on public.parcels
  for insert
  to authenticated
  with check (created_by = auth.uid());

drop policy if exists "Creators can update parcels" on public.parcels;
create policy "Creators can update parcels"
  on public.parcels
  for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

drop policy if exists "Creators can delete parcels" on public.parcels;
create policy "Creators can delete parcels"
  on public.parcels
  for delete
  to authenticated
  using (created_by = auth.uid());

drop policy if exists "Authenticated users can read observations" on public.trap_observations;
create policy "Authenticated users can read observations"
  on public.trap_observations
  for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can create observations" on public.trap_observations;
create policy "Authenticated users can create observations"
  on public.trap_observations
  for insert
  to authenticated
  with check (created_by = auth.uid());

drop policy if exists "Creators can update observations" on public.trap_observations;
create policy "Creators can update observations"
  on public.trap_observations
  for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

drop policy if exists "Creators can delete observations" on public.trap_observations;
create policy "Creators can delete observations"
  on public.trap_observations
  for delete
  to authenticated
  using (created_by = auth.uid());
