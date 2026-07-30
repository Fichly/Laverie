# 🧺 Laverie Mapper — cartographie et aide à l'implantation de laveries

Outil d'étude de marché pour choisir intelligemment la zone d'implantation d'une
laverie automatique. **Ville pilote : Pessac (33600, Bordeaux Métropole).**

## Lancer l'application

Aucun build, aucune dépendance à installer :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

(un serveur local est nécessaire : la page charge les fichiers `data/*.json`)

## Ce que fait la Phase 1 (version actuelle)

- **Inventaire cartographié** : 9 points de lavage recensés à Pessac
  (chaînes, indépendants, laveries captives CROUS), avec fiche par laverie
  (adresse, horaires, note Google, champs terrain à compléter).
- **Statistiques de marché** : nombre de laveries, ratio habitants/laverie
  comparé aux benchmarks du secteur.
- **Zones de chalandise** : rayon piéton paramétrable (300–1000 m) autour de
  chaque laverie, pour visualiser les recouvrements et la saturation.
- **Carte de chaleur de l'offre** : concentration des laveries existantes.
- **Tension du marché par quartier** : croisement offre accessible / demande
  estimée (vert = saturé, jaune = équilibré, rouge = sous-équipé).
- **Simulateur d'implantation** : cliquer sur la carte → population captée,
  ménages cibles, concurrence (modèle de Huff simplifié), fourchette de CA
  potentiel et d'EBE, verdict de viabilité.
- **Benchmarks secteur** intégrés (prix, CA, marges, investissement) —
  uniquement des fourchettes publiques, faute de données d'exploitants.

## Structure

```
index.html            Application (Leaflet, sans framework)
css/style.css
js/app.js             Carte, couches, scoring, simulateur
data/laveries.json    Inventaire des laveries (source de vérité, éditable à la main)
data/quartiers.json   Demande par quartier (estimations → à remplacer par INSEE)
data/benchmarks.json  Hypothèses économiques du secteur (fourchettes)
scripts/sync_osm.py   Synchronisation de l'inventaire avec OpenStreetMap
```

## Fiabilité des données — à lire avant toute décision

| Donnée | État actuel | Cible |
|---|---|---|
| Liste des laveries | Recherche web (annuaires, PagesJaunes, Justacoté, SIRENE) | Croiser OSM (`scripts/sync_osm.py`) + Google Places + **visite terrain** |
| Coordonnées | Estimées depuis l'adresse (±50–300 m) | Géocodage BAN (api-adresse.data.gouv.fr) ou relevé GPS |
| Taille / machines / prix | Non renseignés (`null`) | **Relevé terrain obligatoire** (Street View puis visite) |
| Population par quartier | Estimations d'ordre de grandeur | Carroyage INSEE Filosofi 200 m (gratuit) |
| CA des laveries existantes | Non public (confidentialité des comptes) | Estimation par modèle uniquement, jamais un chiffre affiché comme réel |

Le simulateur affiche **des fourchettes** et documente ses hypothèses
(`data/benchmarks.json`). C'est un outil d'aide à la décision, pas une étude
de marché certifiée.

## Feuille de route

- **Phase 2 — Couche demande réelle** : import du carroyage INSEE 200 m,
  résidences étudiantes, densité Airbnb/hôtels, générateurs de flux OSM
  (supermarchés, arrêts TBM, écoles) → scores de localisation et de trafic
  calculés au lieu d'estimés.
- **Phase 3 — Simulation avancée** : isochrones piéton/voiture
  (OpenRouteService), modèle de Huff complet (attractivité = taille × modernité),
  cannibalisation chiffrée des laveries voisines, croisement avec les locaux
  commerciaux disponibles (loyer, faisabilité technique 24–36 kVA).
- **Phase 4 — Passage à l'échelle** : autres communes de Bordeaux Métropole,
  scoring comparatif inter-villes.

## Collecte terrain (priorité n°1)

Pour chaque laverie, remplir dans `data/laveries.json` : `surface_m2`,
`nb_lave_linge`, `nb_seche_linge`, `prix_cycle_8kg`, `horaires`, l'état général
dans `notes_terrain`, et corriger `lat`/`lon` si besoin (puis passer
`a_verifier` à `false`). Deux passages recommandés : un mardi 10h (creux) et
un samedi 11h (pointe) pour observer le taux d'occupation réel des machines —
c'est le meilleur proxy de CA qui existe.
