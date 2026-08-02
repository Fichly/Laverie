# 🧺 Laverie Mapper — cartographie et aide à l'implantation de laveries

Outil d'étude de marché pour choisir intelligemment la zone d'implantation d'une
laverie automatique. **Périmètre : les 28 communes de Bordeaux Métropole**, avec une vue de détail sur chaque commune.

## Démarrage rapide

**Sur Mac** — double-cliquez `PREPARER.command` à la racine du projet. Un
assistant s'ouvre, cherche vos fichiers, récupère les données publiques et
fabrique l'application. Il explique chaque étape et continue même si l'une
d'elles échoue.

**Sur tout système** :

```bash
python3 scripts/preparer.py
```

L'assistant enchaîne les cinq étapes dans le bon ordre (population INSEE,
laveries de la métropole, générateurs de demande, chiffres d'affaires réels et
historique BODACC) puis
construit `laverie-mapper.html`. Chaque étape est facultative : ce qui manque
est signalé dans le bilan final, et l'application le redit dans son interface.

## Lancer l'application

**Sur Mac** — double-cliquez `LANCER.command`. Un serveur local démarre et votre
navigateur s'ouvre sur la carte.

**Sur tout système** :

```bash
python3 scripts/servir.py     # affiche et ouvre http://localhost:8000/
```

C'est la façon recommandée de travailler : cette version lit `data/*.json` à
chaque chargement, donc **corriger une donnée ou relancer un import se voit d'un
simple rafraîchissement**. Le serveur choisit un port libre si 8000 est pris, et
envoie un en-tête anti-cache — sans lui, le navigateur ressert un fichier périmé
après un import et on croit que le script n'a rien fait.

**Version figée, sans serveur** — `laverie-mapper.html`, ouvrable d'un
double-clic ou transmissible par mail. Un seul fichier, toutes les données
embarquées. Il faut le reconstruire après chaque modification :

```bash
python3 scripts/build_standalone.py
```

## Deux périmètres d'étude : Pessac et Bordeaux Métropole

Le sélecteur en tête de colonne bascule toute l'application d'une échelle à
l'autre — demande, concurrence, calibrage, fiabilité et classement suivent.

| | Pessac | Bordeaux Métropole |
|---|---|---|
| Zones d'analyse | 15 quartiers | 28 communes |
| Calibrage | ~5 laveries grand public | ~20+ (d'autant plus solide) |
| Maille du diagnostic | fine (quartier, générateurs bâtiment par bâtiment) | grossière (commune) — dit où regarder, pas où signer |

**Le garde-fou du mode métropole** : une commune sans laverie recensée ressort
mécaniquement rouge vif (concurrence nulle → indice au plafond). Or « aucune
laverie dans nos données » ne veut pas dire « aucune laverie sur le terrain ».
Toute commune dont l'inventaire est trop maigre pour son gabarit (moins de 60 %
du compte attendu à ~1 laverie / 10 000 habitants) est déclarée **non
évaluable** : estompée en gris sur la heatmap, pointillés sur le diagnostic,
exclue du classement — avec le remède affiché. Pour lever le voile :

```bash
export GOOGLE_MAPS_API_KEY="votre_cle"
python3 scripts/find_laveries_metropole.py --ecrire   # ~48 requêtes, balayage en tuiles
python3 scripts/import_insee_carreaux.py <chemin>/carreaux_200m_met.gpkg  # nouvelle emprise 28 communes
python3 scripts/build_standalone.py
```

## Les données réelles : SIRENE, comptes annuels, BODACC

Le modèle prédisait un chiffre d'affaires sans jamais en observer un seul : il
était calé sur une hypothèse (« une laverie fait 50 000 € »). Trois sources
publiques et gratuites remplacent cette hypothèse par des mesures.

```bash
python3 scripts/import_entreprises.py    # SIRENE + comptes annuels des greffes
python3 scripts/import_bodacc.py         # radiations et prix de cession
python3 scripts/build_standalone.py
```

| Source | Ce qu'elle apporte |
|---|---|
| **SIRENE** | Dates de création et de fermeture, effectifs → durée de vie réelle des laveries, taux de survie à 5 ans |
| **Comptes annuels** | CA et résultat net des sociétés qui déposent au greffe → l'ancre du modèle devient une mesure, et la validation se fait contre du vrai CA |
| **BODACC** | Radiations, et **prix de cession des fonds de commerce** → ce que vaut réellement une laverie en Gironde |

Trois précautions de méthode, appliquées par les scripts :

1. **Le CA est publié au niveau de la société, pas de l'établissement.** Une
   société qui exploite trois laveries publie un cumul, inexploitable pour caler
   une adresse. Chaque ligne porte un `ca_attribuable`, faux dès que la société a
   plus d'un établissement ouvert — et seules les lignes vraies calent le modèle.
2. **La couverture est partielle par construction.** Depuis 2016 les petites
   sociétés peuvent demander la confidentialité de leur compte de résultat, et les
   entreprises individuelles ne déposent rien. Une absence de chiffre n'est pas un
   signal sur la santé de l'affaire.
3. **Le taux de survie exclut les établissements trop récents pour être jugés.**
   Les compter comme survivants gonflerait le résultat (censure à droite).

Une fois les fichiers présents, l'onglet **Modèle** valide le classement contre
le CA réel plutôt que contre le nombre d'avis Google, et affiche l'écart médian
entre CA modélisé et CA publié — la seule mesure qui dise vraiment ce que vaut
le modèle. L'onglet **Laveries** ajoute un panneau « ce que dit le marché réel »,
sans aucun modèle.

## L'interface en quatre onglets

| Onglet | Ce qu'on y fait |
|---|---|
| **Carte** | Choisir *une* vue d'analyse (potentiel, zones étudiantes/HLM, diagnostic par quartier, concentration de l'offre, ou aucune), régler le rayon de chalandise, filtrer ce qui s'affiche. |
| **Analyse** | Le parcours en trois étapes : classement des zones → test d'un local précis → comparaison des candidats. |
| **Laveries** | Les statistiques du marché, ce que disent les chiffres publiés, et l'inventaire complet — indépendant des filtres de la carte. |
| **Modèle** | Le contrôle de fiabilité, les cinq réglages du modèle et les repères du secteur. |

Le périmètre par défaut est la métropole, sauf si l'inventaire est trop maigre
pour elle (moins de 40 laveries) : l'application retombe alors sur Pessac plutôt
que d'afficher une carte creuse où le vide passerait pour une opportunité.

Deux principes de conception valent d'être connus :

- **Une seule surface d'analyse à la fois.** Superposer une heatmap divergente,
  une heatmap séquentielle et des pastilles colorées produit une carte que
  personne ne sait lire. Le choix est donc exclusif, et seule la légende de la
  vue active est affichée.
- **Chaque réglage annonce son effet réel.** Bouger un curseur affiche en bas de
  la carte ce qui a changé : rang de la zone n°1, nombre de zones déplacées,
  variation du CA modélisé — y compris quand la réponse est « rien ». Un modèle
  qui ne montre pas ses propres réactions demande un acte de foi.

Chaque curseur porte une aide dépliable « ce que ça change / ce que ça ne change
pas », renseignée à partir de balayages mesurés, pas d'intentions.

## L'indicateur de fiabilité, en une phrase

Le modèle affiche **un pourcentage, pas un coefficient** : *sur deux laveries
prises au hasard parmi celles qu'on sait mesurer, dans quelle proportion des cas
désigne-t-il correctement la plus performante ?*

- **50 %** = un tirage à pile ou face, le modèle n'apporte rien ;
- **100 %** = classement parfait ;
- au-delà de **70 %**, le classement des zones se défend devant un tiers.

Le calcul forme toutes les paires possibles de laveries existantes et compte
celles que le modèle a mises dans le bon ordre. On raisonne en paires plutôt
qu'en euros parce que choisir un emplacement demande de savoir *lequel est
meilleur*, pas de prédire un chiffre au millier près : un modèle qui se trompe
de 30 % sur tous les montants mais jamais d'ordre reste parfaitement utile.
Quand les comptes annuels sont importés, un second indicateur donne l'écart
médian entre CA modélisé et CA réel — c'est celui-là qui juge les euros.

La corrélation de rang (Spearman) reste affichée en bas du panneau, pour qui
veut le chiffre technique.

## Les générateurs de demande

Résidences étudiantes, logements sociaux et hébergements touristiques sont
recensés bâtiment par bâtiment et posés en **pins colorés** sur la vue
« Zones étudiantes, HLM… », avec un filtre par famille :

Deux sources complémentaires, dédoublonnées entre elles :

```bash
python3 scripts/import_crous.py --ecrire                # parc public, sans clé
python3 scripts/find_generateurs.py --type residence_etudiante --ecrire
python3 scripts/find_generateurs.py --ecrire            # les trois familles
```

**Le CROUS d'abord** : le CNOUS publie son parc académie par académie, en accès
libre et sans clé, avec les positions officielles et souvent la capacité
d'accueil — donc un vrai nombre de logements au lieu d'une valeur par défaut. Le
flux existe pour les 26 académies (`--academie lyon`, `--academie lille`…), ce
qui rend l'extension à d'autres villes immédiate.

Il ne couvre que le parc **public** : les résidences privées (Studéa, Estudines,
Yugo, Nemea) et les logements sociaux passent par le balayage Google. Quand les
deux sources décrivent le même bâtiment, il n'est compté qu'une fois et la
position officielle du CROUS l'emporte.

Le balayage couvre les 28 communes en 12 tuiles (~150 requêtes pour tout,
une cinquantaine pour les seules résidences étudiantes). **Les générateurs déjà
enregistrés sont conservés avec leurs corrections** : le nombre de logements
saisi à la main est le travail le plus coûteux du projet, un nouveau balayage ne
l'écrase jamais.

Décocher une famille masque ses pins et sa contribution au fond coloré, mais ne
retire rien au modèle : la demande reste comptée dans le potentiel.

### Les zones de besoin

La vue ne se contente pas de poser des pins : elle répond à « où sont les
étudiants, où sont les HLM, et où ce monde-là n'a pas de laverie ».

**La couleur dit qui habite là.** Chaque famille a sa teinte — ambre pour
l'étudiant, rose pour le logement social, vert pour le tourisme —, la même que
son pin. Une maille de 60 m mélange les teintes au prorata de ses habitants,
pondérées au carré pour que les secteurs franchement dominés restent lisibles.
L'intensité dit combien, le trait foncé marque la limite du secteur habité.

**Les pastilles numérotées disent où regarder.** Une zone n'est pas une tache
contiguë — en ville dense, tout se touche, et un premier essai par composantes
connexes rendait *une* grappe de 11 000 ménages allant du campus de Talence au
centre de Bordeaux : vraie topologiquement, inutilisable commercialement. Une
zone est donc **une implantation possible** : on cherche le point qui capterait
le plus de ménages captifs dans un rayon de 800 m, on lui attribue ces
bâtiments, on les retire du jeu, et on recommence. Deux zones ne peuvent pas se
revendiquer le même immeuble, et l'étendue d'une zone ne dépasse jamais son
rayon de chalandise.

**Le besoin** vaut `ménages sans lave-linge / (pression concurrentielle +
option extérieure)` — le dénominateur du modèle de Huff, qui empêche une zone
sans laverie d'afficher un besoin infini. Le résultat est rapporté à la **zone
médiane du périmètre** : « 2,4× » signifie 2,4 fois plus de ménages captifs par
laverie accessible que la zone médiane. Référence relative, comme partout dans
l'app — un seuil absolu supposerait connaître le panier moyen et le taux
d'équipement réels, qui ne sont pas mesurés ici.

Le classement complet est dans l'onglet **Analyse**. Attention à ne pas le
confondre avec « les zones les plus prometteuses » : celui-ci ne compte que la
demande **captive**, l'autre compte toute la population.

Limite connue et non résolue : le nombre de logements de chaque bâtiment reste
une valeur par défaut selon le type, sauf là où il a été corrigé à la main.
C'est la principale source d'erreur de cette vue.

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
- **Simulateur d'implantation** : tester un local précis en collant son lien
  Google Maps ou ses coordonnées (clic droit sur Maps → « Copier les
  coordonnées »), ou en cliquant sur la carte → population captée, clientèle
  régulière et ponctuelle, concurrence, fourchette de CA et d'EBE, verdict.
- **Emplacements candidats** : garder plusieurs locaux étudiés, les comparer
  dans un tableau trié par CA potentiel, les retrouver sur la carte. Ils sont
  conservés dans le fichier exporté.
- **Hypothèses ajustables** : cinq curseurs (dépense annuelle d'un ménage sans
  lave-linge, niveau de demande, CA de référence, portée des laveries avec
  parking, loyer) recalculent tout en direct. C'est le meilleur moyen de
  vérifier qu'un classement tient malgré l'incertitude sur les données de
  population. Résultat du balayage complet sur Pessac : **la zone n°1 ne change
  avec aucun d'eux**, et au pire 6 quartiers sur 15 permutent en milieu de
  tableau.
- **Tendance des avis** : la note moyenne masque l'évolution. Une laverie à 4,3
  dont tous les avis récents sont à 1★ se dégrade — donc une opportunité que la
  note seule ne montre pas.
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
4. **Le CA est plafonné par la capacité physique.** Une laverie ne peut pas
   encaisser plus que ce que ses machines produisent (parc type × rendement par
   machine, soit 126 000 €). Quand la demande dépasse ce plafond, l'outil ne
   promet pas un CA impossible : il signale que la zone porterait un très grand
   format ou deux implantations.
5. **Un seul calcul pour deux affichages.** La fonction `estimerCA()` alimente
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
scripts/find_generateurs.py      Localise résidences étudiantes et logement social
scripts/import_insee_carreaux.py Importe le carroyage INSEE 200 m (voir DONNEES_INSEE.md)
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
fiabiliser le classement des zones — mode d'emploi complet dans
[DONNEES_INSEE.md](DONNEES_INSEE.md), script d'import prêt à l'emploi.

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
