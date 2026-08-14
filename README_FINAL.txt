SAM PIÉGEAGE — VERSION FINALE LOGO + MOBILE
===============================================

FICHIERS À REMPLACER SUR GITHUB
-------------------------------
- index.html
- style.css
- app.js
- site.webmanifest
- favicon.ico
- favicon.png
- apple-touch-icon.png
- android-chrome-192x192.png
- android-chrome-512x512.png
- icon-192-maskable.png
- icon-512-maskable.png

FICHIER À AJOUTER
-----------------
- logo-sam-piegeage.png

À CONSERVER
-----------
- logo-sudexpe.png
- config.js
- service-worker.js
- supabase_patch_public_read.sql

MODIFICATIONS INTÉGRÉES
-----------------------
- toutes les icônes de l'application sont remplacées par le nouveau logo SAM Piégeage ;
- le nouveau logo est affiché dans le bandeau rouge, à droite du logo SudExpé ;
- sur téléphone, l'encart Installer apparaît dans le bandeau, à gauche du bouton Connexion ;
- cet encart Installer disparaît automatiquement une fois l'application installée ;
- sur téléphone, l'encart de connexion est caché par défaut ;
- un bouton Connexion en haut à droite permet d'ouvrir l'encart de connexion ;
- une fois connecté, le bouton devient Connecté et l'encart peut afficher le compte et la déconnexion.

SUPABASE
--------
Aucune modification Supabase n'est nécessaire pour ces changements d'interface et d'icônes.

APRÈS MISE EN LIGNE
-------------------
1. remplace les fichiers à la racine du dépôt ;
2. attends le redéploiement ;
3. fais Ctrl + F5 sur ordinateur ;
4. sur téléphone, si une ancienne version est installée, supprime-la puis réinstalle-la.
