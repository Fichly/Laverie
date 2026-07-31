# Où trouver le nombre d'habitants par zone

Toutes les sources ci-dessous sont **gratuites et publiques**. Elles sont classées
par utilité pour ce projet, pas par notoriété.

---

## 1. INSEE Filosofi carroyé 200 m — la source à récupérer en priorité

C'est la donnée qui débloque le modèle : la population **réellement observée**,
carreau de 200 m par carreau de 200 m, sur toute la France. Pas une estimation,
pas une moyenne communale — le compte réel.

**Où :** [data.gouv.fr — Revenus, pauvreté et niveau de vie, données carroyées
2019 et 2021](https://www.data.gouv.fr/datasets/revenus-pauvrete-et-niveau-de-vie-donnees-carroyees-2019-et-2021-dispositif-fichier-localise-social-et-fiscal-filosofi)
ou directement [insee.fr — Données au carreau de 200 m](https://www.insee.fr/fr/statistiques/7655475).
Prendre le **millésime le plus récent** (2021 à ce jour) et la **France
métropolitaine**. Formats : CSV, Shapefile, ou Parquet.

**Une trentaine de variables**, dont celles qui nous intéressent directement :

| Variable | Contenu | Pourquoi c'est utile ici |
|---|---|---|
| `idcar_200m` | Identifiant du carreau | Contient les coordonnées (voir plus bas) |
| `ind` | Nombre d'individus | La population, enfin réelle |
| `men` | Nombre de ménages | L'unité qui compte pour une laverie |
| `men_1ind` | Ménages d'une seule personne | **Le meilleur proxy des petits logements**, donc des ménages sans lave-linge |
| `men_pauv` | Ménages pauvres | Corrélé à l'usage des laveries |
| `log_soc` | Logements sociaux | Répond directement à votre question sur les HLM |

`men_1ind` et `log_soc` sont exactement ce qui manque au modèle : ils
remplacent mes `part_petits_logements_est` inventées à la main.

**Import :**

```bash
mkdir -p data/source            # y déposer le CSV téléchargé
python3 scripts/import_insee_carreaux.py data/source/<le_fichier>.csv
python3 scripts/build_standalone.py
```

Le script détecte tout seul les noms de colonnes (l'INSEE les fait varier d'un
millésime à l'autre), ne garde que les carreaux de l'emprise de Pessac, et
convertit les coordonnées. Il commence toujours par un autotest de la
projection — s'il échoue, il s'arrête plutôt que d'écrire des données fausses.

**Le piège technique, déjà traité :** les identifiants de carreaux sont du type
`CRS3035RES200mN2470400E3481600`. Ce ne sont ni des latitudes ni des Lambert 93,
mais des coordonnées **ETRS89-LAEA (EPSG:3035)**, la projection européenne. La
conversion est implémentée dans le script sans dépendance (ni pyproj ni GDAL) et
vérifiée au millimètre sur trois points de contrôle. Attention aussi : l'identifiant
désigne le **coin sud-ouest** du carreau, pas son centre — le script ajoute les
100 m nécessaires.

---

## 2. RPLS — le fichier des logements sociaux

C'est **la** réponse pour les HLM. Le Répertoire des logements locatifs des
bailleurs sociaux recense chaque logement social de France, avec la commune, le
bailleur, l'année de construction et le nombre de pièces.

**Où :** chercher « RPLS » sur [data.gouv.fr](https://www.data.gouv.fr) (publié
annuellement par le SDES, ministère de la Transition écologique).

Il donne le nombre exact de logements par programme — précisément ce qui manque
aux 56 générateurs de demande de l'outil, où j'ai mis des valeurs par défaut.

---

## 3. Recensement à l'IRIS — le détail du logement

L'IRIS est le découpage INSEE en quartiers d'environ 2 000 habitants. Moins fin
que le carroyage, mais bien plus riche sur le logement.

**Où :** insee.fr, « Recensement de la population — Logement (IRIS) ». Contours
géographiques : IGN, « Contours IRIS ».

Variables utiles : nombre de pièces des résidences principales (les T1-T2 sont
la cible), statut d'occupation (locataires), période de construction, et la
part de logements sans équipement.

---

## 4. Vos générateurs de demande, bâtiment par bâtiment

Pour corriger les nombres de logements des 56 bâtiments repérés dans l'outil :

- **CROUS Bordeaux-Aquitaine** publie la capacité de chaque résidence
  universitaire (nombre de logements, type). Une vingtaine de résidences à
  Pessac — comptez une heure de collecte.
- **Bailleurs sociaux** : Domofrance, Gironde Habitat, Clairsienne, Mésolia et
  Aquitanis publient le nombre de logements par programme sur leur site.
- **BD TOPO (IGN)** : la couche `BATIMENT` porte la hauteur et le nombre
  d'étages, ce qui permet d'estimer un nombre de logements quand aucune source
  ne le donne. Gratuit sur [geoservices.ign.fr](https://geoservices.ign.fr).

---

## 5. Repères de cadrage

- **geo.api.gouv.fr** — population communale, contours, sans inscription.
- **Base Adresse Nationale (BAN)** — géocodage gratuit et illimité, utile pour
  transformer une liste d'adresses de bailleur en points sur la carte :
  `https://api-adresse.data.gouv.fr/search/?q=...`

---

## Ce que ça change concrètement

Aujourd'hui le contrôle de fiabilité de l'outil affiche **+0,30** : le modèle
n'explique qu'à peine les laveries déjà en place. La cause est identifiée — la
demande repose sur 15 centroïdes de quartiers dont j'ai inventé les populations.

Le carroyage INSEE remplace ces 15 points par environ **900 carreaux mesurés**
sur l'emprise de Pessac. C'est le seul changement qui puisse faire remonter
franchement cet indicateur — et il est mesurable : si la corrélation passe au
vert après l'import, la heatmap devient exploitable devant un banquier.
