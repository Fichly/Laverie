# 🧺 Laverie Mapper — cartographie et aide à l'implantation de laveries

Outil d'étude de marché pour choisir intelligemment la zone d'implantation d'une
laverie automatique. **Ville pilote : Pessac (33600, Bordeaux Métropole).**

## Lancer l'application

**Le plus simple — version autonome :** ouvrir `laverie-mapper.html` d'un
double-clic. Un seul fichier, aucune installation, aucun serveur. Une connexion
internet est nécessaire uniquement pour afficher le fond de carte.

**Version modulaire** (pour développer, avec les données dans des fichiers
séparés) :

```bash
python3 -m http.server 8000   # puis ouvrir http://localhost:8000
```

Après toute modification de `data/*.json`, régénérer le fichier autonome :

```bash
python3 scripts/build_standalone.py
```

## Ce que fait la Phase 1 (version actuelle)

- **Inventaire cartographié** : 9 points de lavage recensés à Pessac
  (chaînes, indépendants, laveries captives CROUS), avec fiche par laverie
  et liste cliquable pour contrôler chaque emplacement.
- **Indicateur de complétude** : part des champs terrain effectivement
  renseignés (11 % aujourd'hui — le relevé terrain reste à faire).
- **Statistiques de marché** : nombre de laveries, ratio habitants/laverie
  comparé aux benchmarks du secteur.
- **Zones de chalandise** : rayon piéton paramétrable (300–1000 m) autour de
  chaque laverie, pour visualiser les recouvrements et la saturation.
- **Carte de chaleur de l'offre** : concentration des laveries existantes.
- **Potentiel par quartier** : rouge = une nouvelle laverie y dégagerait plus
  que le CA médian du secteur, vert = pas de place.
- **Classement des zones d'implantation** : les 6 meilleures zones triées par
  CA potentiel, cliquables pour lancer directement la simulation.
- **Simulateur d'implantation** : cliquer sur la carte → population captée,
  clientèle régulière et ponctuelle, concurrence, fourchette de CA et d'EBE,
  verdict de viabilité.
- **Benchmarks secteur** intégrés (prix, CA, marges, investissement) —
  uniquement des fourchettes publiques, faute de données d'exploitants.

## Le modèle en quatre idées

1. **Deux clientèles, pas une.** Les ménages *sans lave-linge* (2 % en secteur
   pavillonnaire, jusqu'à 10 % là où dominent studios et T1) viennent chaque
   semaine et dépensent 300–700 €/an. Tous les autres viennent 1 à 3 fois par an
   pour les couettes : 20–45 €/an. Les confondre fausse totalement l'estimation.
2. **Toutes les laveries ne se valent pas.** Chacune reçoit une *force
   concurrentielle* de 0 à 100 (`attractivite()`), croisant sa note Google
   lissée par le volume d'avis, son nombre de machines **en service** et son
   accessibilité (une laverie de résidence CROUS ne pèse que 40 %). Une adresse
   notée 1,9/5 avec la moitié du parc en panne ne bloque pas une zone comme une
   enseigne moderne à 4,3/5 — c'est ce qui distingue une zone verrouillée d'une
   zone à reprendre.
3. **La part de marché se dispute.** Chaque laverie réduit la part captable
   selon sa force et sa distance (modèle de Huff, décroissance gaussienne).
4. **Un seul calcul pour deux affichages.** La fonction `estimerCA()` alimente
   à la fois la couleur des quartiers et le simulateur : les deux lectures de la
   carte ne peuvent pas se contredire.

Les laveries mal notées sur un volume d'avis crédible sont cerclées d'orange sur
la carte et marquées « 🎯 cible » dans la liste : ce sont les emplacements à
concurrencer ou à reprendre.

L'indice affiché est le rapport entre le CA médian estimé de la zone et le CA
médian d'une laverie du secteur (85 000 €). Au-dessus de 1, la zone porte une
laverie de taille normale.

## Structure

```
laverie-mapper.html          Version autonome, générée — à ouvrir d'un double-clic
index.html                   Application (Leaflet, sans framework)
css/style.css
js/app.js                    Carte, couches, modèle, simulateur
data/laveries.json           Inventaire des laveries (source de vérité, éditable à la main)
data/quartiers.json          Demande par quartier (estimations → à remplacer par INSEE)
data/benchmarks.json         Hypothèses économiques du secteur (fourchettes)
scripts/sync_osm.py          Synchronisation de l'inventaire avec OpenStreetMap
scripts/enrich_google_places.py  Notes, avis, photos et positions via l'API Google
scripts/geocode_quartiers.py     Recale les centroïdes de quartiers via l'API Google
scripts/build_standalone.py  Génère laverie-mapper.html
```

## Limite connue : la maille de la demande

Les 9 laveries sont géolocalisées au mètre par Google. La **demande**, elle,
repose encore sur 15 centroïdes de quartiers — désormais ancrés sur des
équipements réels (mairie, collège, centre social, gare) via
`scripts/geocode_quartiers.py`, mais avec une population toujours estimée.

Pour éviter les faux points chauds là où deux centroïdes se rapprochent, la
population de chaque quartier est étalée sur un disque de 450 m plutôt que
concentrée en un point. C'est un pis-aller : le correctif définitif reste
l'import du **carroyage INSEE Filosofi 200 m** (gratuit), qui donne la
population réellement observée maille par maille. C'est la priorité n°1 pour
fiabiliser le classement des zones.

## Récupérer les infos d'une fiche Google — deux méthodes

### A. Saisie manuelle dans l'application (aucune clé, immédiat)

C'est la méthode la plus rapide pour quelques établissements :

1. Ouvrez la fiche Google Maps de la laverie dans un onglet.
2. Dans l'outil, cliquez la laverie puis **✏️ Compléter**.
3. Recopiez note, nombre d'avis, téléphone, horaires — et pendant que vous y
   êtes, le nombre de machines, la surface et le prix du cycle 8 kg.
4. **Glissez-déposez les photos** (captures de la fiche, photos de terrain) :
   elles sont redimensionnées à 900 px et stockées directement dans vos données.
5. Cliquez **Enregistrer**, puis **💾 Exporter laveries.json** (bouton flottant
   en bas à droite, visible dès qu'il y a des modifications).
6. Remplacez `data/laveries.json` par le fichier téléchargé, puis relancez
   `python3 scripts/build_standalone.py`.

Les modifications vivent en mémoire tant que vous n'avez pas exporté — l'onglet
vous avertit si vous le fermez avant.

### B. API Google Places (automatique, officiel, photos incluses)

Pour obtenir les données **officielles** (note exacte, avis complets, photos,
horaires, coordonnées GPS précises) sur tout l'inventaire d'un coup :

```bash
export GOOGLE_MAPS_API_KEY="votre_cle"
python3 scripts/enrich_google_places.py --test         # vérifie la clé
python3 scripts/enrich_google_places.py --decouverte   # récupère tout
python3 scripts/build_standalone.py                    # régénère le fichier autonome
```

📖 **Marche à suivre complète pour créer la clé : [GOOGLE_API.md](GOOGLE_API.md)**
(création du projet, facturation, restrictions, garde-fou budget, erreurs
courantes). Compter 15 minutes la première fois.

`--decouverte` cherche en plus les laveries absentes de l'inventaire.
`--id laverie-de-saige` ne traite qu'un établissement. `--sans-photos` évite
le téléchargement d'images.

**Pourquoi une clé API et pas du scraping ?** Récupérer les pages Google Maps
viole leurs conditions d'utilisation et les photos sont protégées. L'API est la
seule voie propre : elle fournit les mentions d'attribution obligatoires, que le
script conserve et que l'application affiche sous chaque galerie. Deux règles
Google à respecter : les `place_id` se conservent sans limite, mais les notes,
avis et photos ne doivent pas être stockés au-delà de 30 jours — relancez le
script plutôt que de traiter le cache comme une base pérenne.

## Fiabilité des données — à lire avant toute décision

| Donnée | État actuel | Cible |
|---|---|---|
| Liste des laveries | 8 établissements — recherche web (annuaires, PagesJaunes, Justacoté, SIRENE) | Croiser OSM (`scripts/sync_osm.py`) + Google Places + **visite terrain** |
| Notes et avis | 5 laveries notées sur 8 — les 2 Au Fil du Linge relevées sur Google, les autres via annuaires | Saisie manuelle (**✏️ Compléter**) ou `scripts/enrich_google_places.py` |
| Photos | Aucune | Glisser-déposer dans la fiche, ou `scripts/enrich_google_places.py` (avec attribution) |
| Coordonnées | Estimées depuis l'adresse (±50–300 m) | Géocodage BAN (api-adresse.data.gouv.fr), Google Places ou relevé GPS |
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
