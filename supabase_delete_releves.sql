-- SAM Piégeage : autoriser les comptes connectés à supprimer un relevé
-- À exécuter une seule fois dans Supabase > SQL Editor.

grant delete on public.piegeage_observations to authenticated;

drop policy if exists "Authenticated delete piegeage observations"
on public.piegeage_observations;

create policy "Authenticated delete piegeage observations"
on public.piegeage_observations
for delete
to authenticated
using (true);

notify pgrst, 'reload schema';
