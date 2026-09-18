SAM PIÉGEAGE — PARCELLES AVEC LE MÊME NOM
===========================================

NOUVELLE RÈGLE
--------------
Plusieurs parcelles peuvent avoir exactement le même nom.

Elles sont considérées comme différentes dès qu'au moins un de ces éléments diffère :
- exploitation ;
- variété ;
- surface.

SAM bloque seulement un doublon parfaitement identique :
même exploitation + même nom + même variété + même surface.

AFFICHAGE
---------
Pour éviter les confusions, les listes affichent maintenant :
Nom — Exploitation — Variété — Surface

IMPORT EXCEL
------------
Le format simple reste inchangé :
G
J
L
N

Si un nom n'existe qu'une seule fois dans la campagne, SAM le reconnaît automatiquement.

Si deux parcelles de la même campagne portent le même nom, le nom seul devient ambigu.
Dans ce cas seulement, la première colonne peut utiliser :
Nom | Exploitation | Variété | Surface

Exemple :
G | SudExpé Marsillargues | Opal | 1,25

SUPABASE
--------
Exécuter une seule fois supabase_parcelles_homonymes.sql.
Le script retire uniquement d'éventuelles contraintes UNIQUE trop restrictives
sur le nom ou sur exploitation + nom. Il ne supprime aucune donnée.
