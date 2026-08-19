-- SAM Piégeage — suppression des parcelles par un utilisateur connecté
-- À exécuter une seule fois dans Supabase > SQL Editor.

grant delete on public.piegeage_parcels to authenticated;

drop policy if exists "Authenticated delete piegeage parcels"
on public.piegeage_parcels;

create policy "Authenticated delete piegeage parcels"
on public.piegeage_parcels
for delete
to authenticated
using (true);

notify pgrst, 'reload schema';
