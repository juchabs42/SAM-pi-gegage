SAM PIÉGEAGE — FICHIERS GITHUB
===============================

Version :
- lecture publique sans compte ;
- connexion e-mail + mot de passe dans l'encart en haut à droite ;
- aucun bouton de création de compte sur le site ;
- création de parcelle et ajout de relevé uniquement après connexion ;
- bouton « Ajouter un relevé » sous « Créer une parcelle » ;
- filtre « Toutes les parcelles » permettant de comparer les courbes d'une même exploitation ;
- historique consultable en lecture seule ;
- tables utilisées exclusivement :
  piegeage_parcels
  piegeage_observations
- aucun stockage local ;
- aucun jeu de données de démonstration.

FICHIERS À METTRE SUR GITHUB
----------------------------
index.html
style.css
app.js
config.js
logo-sudexpe.png
favicon.png

SUPABASE
--------
Exécuter le fichier :
supabase_patch_public_read.sql

Il autorise :
- anon : SELECT uniquement ;
- authenticated : SELECT + INSERT ;
- UPDATE/DELETE uniquement sur les lignes créées par l'utilisateur.

Dans Authentication :
1. conserver Email comme méthode de connexion ;
2. désactiver « Allow new users to sign up » ;
3. désactiver « Allow anonymous sign-ins » ;
4. créer les comptes uniquement depuis Authentication > Users.

CACHE
-----
index.html charge app.js, style.css et config.js avec un paramètre de version.
Les noms de fichiers restent stables, mais le navigateur est forcé à reprendre les nouveaux fichiers.
