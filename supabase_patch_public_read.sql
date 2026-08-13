-- SAM Piégeage — accès public en lecture seule + écriture réservée aux comptes connectés
-- À exécuter dans Supabase > SQL Editor > New query.

alter table public.piegeage_parcels enable row level security;
alter table public.piegeage_observations enable row level security;

-- Privilèges API
grant select on public.piegeage_parcels to anon, authenticated;
grant select on public.piegeage_observations to anon, authenticated;
grant insert, update, delete on public.piegeage_parcels to authenticated;
grant insert, update, delete on public.piegeage_observations to authenticated;

-- Supprime les anciennes politiques éventuelles.
drop policy if exists "Lecture parcelles" on public.piegeage_parcels;
drop policy if exists "Création parcelles" on public.piegeage_parcels;
drop policy if exists "Modification parcelles" on public.piegeage_parcels;
drop policy if exists "Suppression parcelles" on public.piegeage_parcels;
drop policy if exists "Authenticated users can read parcels" on public.piegeage_parcels;
drop policy if exists "Authenticated users can create parcels" on public.piegeage_parcels;
drop policy if exists "Creators can update parcels" on public.piegeage_parcels;
drop policy if exists "Creators can delete parcels" on public.piegeage_parcels;

drop policy if exists "Lecture relevés" on public.piegeage_observations;
drop policy if exists "Création relevés" on public.piegeage_observations;
drop policy if exists "Modification relevés" on public.piegeage_observations;
drop policy if exists "Suppression relevés" on public.piegeage_observations;
drop policy if exists "Authenticated users can read observations" on public.piegeage_observations;
drop policy if exists "Authenticated users can create observations" on public.piegeage_observations;
drop policy if exists "Creators can update observations" on public.piegeage_observations;
drop policy if exists "Creators can delete observations" on public.piegeage_observations;

-- Lecture publique : aucune connexion nécessaire.
create policy "Public read piegeage parcels"
on public.piegeage_parcels
for select
to anon, authenticated
using (true);

create policy "Public read piegeage observations"
on public.piegeage_observations
for select
to anon, authenticated
using (true);

-- Création : uniquement pour les comptes authentifiés.
create policy "Authenticated insert piegeage parcels"
on public.piegeage_parcels
for insert
to authenticated
with check ((select auth.uid()) = created_by);

create policy "Authenticated insert piegeage observations"
on public.piegeage_observations
for insert
to authenticated
with check ((select auth.uid()) = created_by);

-- Modification / suppression : uniquement par l'auteur de la ligne.
create policy "Owner update piegeage parcels"
on public.piegeage_parcels
for update
to authenticated
using ((select auth.uid()) = created_by)
with check ((select auth.uid()) = created_by);

create policy "Owner delete piegeage parcels"
on public.piegeage_parcels
for delete
to authenticated
using ((select auth.uid()) = created_by);

create policy "Owner update piegeage observations"
on public.piegeage_observations
for update
to authenticated
using ((select auth.uid()) = created_by)
with check ((select auth.uid()) = created_by);

create policy "Owner delete piegeage observations"
on public.piegeage_observations
for delete
to authenticated
using ((select auth.uid()) = created_by);

notify pgrst, 'reload schema';
