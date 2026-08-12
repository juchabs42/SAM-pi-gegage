SAM PIÉGEAGE — SUDEXPÉ
========================

Cette version est dédiée uniquement au piégeage des ravageurs.

PRINCIPALES MODIFICATIONS
-------------------------
- Suppression de la vue générale, du module tavelure et des données de démonstration.
- Utilisation du logo SudExpé et de sa couleur principale (#D31145).
- Filtres conservés en haut :
  ravageur, année, exploitation, parcelle, calcul, affichage.
- Création d’une parcelle avec :
  exploitation, parcelle, variété, surface.
- Saisie d’un relevé avec uniquement :
  date du relevé + nombre de captures.
  Le ravageur et la parcelle viennent des sélections du haut.
- Conservation de :
  4 indicateurs, dynamique saisonnière, historique, comparaison parcelle.
- Base Supabase :
  historique partagé entre plusieurs utilisateurs connectés.
- Authentification Supabase par e-mail / mot de passe.
- Export CSV de la sélection active.
- Mise en page responsive ordinateur + téléphone.
- Aucun relevé fictif n’est préchargé.

FICHIERS
--------
index.html
  Structure de l’application.

style.css
  Mise en forme responsive aux couleurs SudExpé.

app.js
  Connexion Supabase, authentification, parcelles, relevés, filtres,
  graphique, historique et export CSV.

config.js
  URL et clé publique "anon" de votre projet Supabase.

supabase_schema.sql
  Tables, index et règles RLS à exécuter dans Supabase.

logo-sudexpe.png
favicon.png
  Logo fourni, recadré pour l’interface et l’onglet du navigateur.

MISE EN PLACE SUPABASE
----------------------
1. Créer un projet sur Supabase.

2. Dans Supabase, ouvrir :
   SQL Editor > New query

3. Copier tout le contenu de :
   supabase_schema.sql
   puis exécuter la requête.

4. Vérifier l’authentification :
   Authentication > Providers > Email
   et laisser le fournisseur Email activé.

5. Dans :
   Project Settings > API
   récupérer :
   - Project URL
   - la clé publique "anon" / publishable key

6. Ouvrir config.js et remplacer :
   https://VOTRE-PROJET.supabase.co
   VOTRE_CLE_ANON

7. Ne jamais mettre la clé "service_role" dans config.js.

8. Déposer tous les fichiers à la racine de votre dépôt GitHub/GitLab
   ou de votre hébergement statique.

COMPTES UTILISATEURS
--------------------
L’écran de connexion permet :
- de se connecter ;
- de créer un compte.

Selon la configuration Supabase, un nouvel utilisateur peut devoir
valider son adresse e-mail avant sa première connexion.

SÉCURITÉ
--------
Les règles RLS du fichier SQL font que :
- un utilisateur authentifié peut consulter toutes les parcelles et
  tous les relevés de l’outil ;
- il peut créer une parcelle ou un relevé ;
- il ne peut modifier/supprimer que les lignes qu’il a lui-même créées.

La clé "anon" peut être présente dans un site web public uniquement
si les règles RLS sont correctement activées.

HÉBERGEMENT
-----------
L’application utilise :
- Supabase JS via CDN ;
- Chart.js via CDN.

Une connexion internet est donc nécessaire.

Pour GitHub Pages :
Settings > Pages > Deploy from a branch > main > /(root)

Si vous utilisez déjà un dépôt pour SAM, remplacez uniquement les
fichiers de cette application par ceux de ce dossier.
