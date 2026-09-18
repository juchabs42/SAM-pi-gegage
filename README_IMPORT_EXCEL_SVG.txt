SAM PIÉGEAGE — IMPORT EXCEL + EXPORT SVG
=========================================

FICHIERS À REMPLACER SUR GITHUB
--------------------------------
- index.html
- style.css
- app.js
- service-worker.js

AUCUNE MODIFICATION SUPABASE N'EST NÉCESSAIRE.

IMPORT EXCEL
------------
Dans « + Relevé », sélectionne la campagne puis choisis un fichier Excel.

Structure attendue :
- première ligne : Dates | 23/3 | 24/3 | 25/3 | ...
- première colonne : nom de la parcelle exactement comme dans SAM, sans la variété
- autres cellules : nombre total de captures
- cellule vide = aucun relevé à importer
- 0 = un relevé avec zéro capture

Les dates sans année utilisent automatiquement l'année de la campagne.

Règles pièges :
- si une parcelle possède un seul piège actif dans la campagne, il est utilisé automatiquement ;
- si elle en possède plusieurs, sélectionne d'abord cette parcelle et le piège souhaité dans la fenêtre Relevé, puis relance l'analyse ;
- une parcelle sans piège actif ne peut pas être importée.

Les relevés déjà présents pour le même piège et la même date sont ignorés pour éviter les doublons.

PROTOCOLE AVANCÉ
-----------------
L'Excel importe le « total capturé ».
Pour une campagne en protocole avancé, l'identification M/F/indéterminés reste à compléter ensuite dans SAM.

EXPORT SVG
----------
Le bouton « Exporter SVG » exporte le graphique correspondant exactement aux filtres affichés :
campagne, parcelle, piège, donnée, sexe, unité et traitement de la courbe.
Les interventions / événements visibles sont également représentés dans le fichier SVG.
