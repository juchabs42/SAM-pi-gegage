SAM PIÉGEAGE — AFFICHAGE DES INTERVENTIONS ET INSTALLATIONS
=========================================================

FICHIERS À REMPLACER SUR GITHUB
--------------------------------
- index.html
- app.js
- service-worker.js

AUCUNE MODIFICATION SUPABASE N'EST NÉCESSAIRE.

INTERVENTIONS
-------------
- La bulle jaune "date · Intervention : ..." n'est plus affichée sous le graphique.
- Le contenu du champ "Type d'intervention" est affiché directement en haut du graphique,
  au-dessus du pointillé jaune correspondant à la date.
- Si plusieurs interventions ont lieu le même jour, leurs types sont regroupés sur le même repère.

PIÈGES
------
- Les installations de plusieurs pièges le même jour sont regroupées dans une seule bulle.
- Exemple :
  23/03/2026 · Piège : Installation parcelle J, parcelle I
- Si plusieurs pièges sont installés le même jour dans une même parcelle, le nom de la parcelle
  n'est affiché qu'une seule fois.
- Les autres événements de piège restent affichés séparément.

EXPORT SVG
----------
Le texte du type d'intervention est également placé au-dessus du pointillé dans l'export SVG.
