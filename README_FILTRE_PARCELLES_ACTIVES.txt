SAM PIÉGEAGE — FILTRE DES PARCELLES ACTIVES
==========================================

FICHIERS À REMPLACER SUR GITHUB
--------------------------------
- index.html
- app.js
- service-worker.js

AUCUNE MODIFICATION SUPABASE N'EST NÉCESSAIRE.

NOUVELLE RÈGLE
--------------
Dans une campagne, le filtre « Parcelle » n'affiche désormais que les parcelles
qui possèdent au moins un piège NON ARCHIVÉ dans cette campagne.

Les anciennes associations campagne/parcelle restent conservées dans Supabase
pour l'historique, mais elles ne font plus apparaître une parcelle dans les
filtres si tous ses pièges ont été archivés.

La même règle est utilisée pour :
- le filtre principal Parcelle ;
- la saisie d'un relevé ;
- l'import Excel ;
- les parcelles proposées pour une intervention.

Lors de la création d'un nouveau piège, toutes les parcelles actives de SAM
restent disponibles : ce changement ne bloque donc pas la réutilisation d'une
parcelle dans une campagne.
