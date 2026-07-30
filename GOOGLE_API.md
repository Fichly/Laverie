# Récupérer automatiquement les fiches Google — pas à pas

Objectif : que le script aille chercher tout seul, pour chaque laverie, la note
exacte, le nombre d'avis, le texte des avis, les photos, les horaires, le
téléphone et les coordonnées GPS précises.

Compter **15 minutes** la première fois. Ensuite, une seule commande suffit.

---

## 1. Créer un projet Google Cloud

1. Aller sur **https://console.cloud.google.com** et se connecter avec un compte
   Google (le même que Gmail, peu importe lequel).
2. En haut à gauche, cliquer sur le sélecteur de projet → **Nouveau projet**.
3. Nom : `laverie-mapper` (ou ce que vous voulez) → **Créer**.
4. Vérifier que ce projet est bien celui sélectionné en haut de l'écran.

## 2. Activer la facturation — l'étape que tout le monde saute

Google exige une carte bancaire pour utiliser l'API, **même en restant dans le
quota gratuit**. Sans cela, chaque appel est refusé.

1. Menu ☰ → **Facturation** → **Associer un compte de facturation**.
2. Créer un compte de facturation, renseigner la carte.

**Ce que ça coûte réellement pour ce projet :** enrichir 8 laveries représente
une trentaine d'appels. Le quota mensuel gratuit de Google se compte en
milliers d'appels par famille de service. À cette échelle vous restez très
largement dans le gratuit. Le risque n'est pas la facture, c'est d'oublier une
boucle qui tourne — d'où l'étape 5.

## 3. Activer « Places API (New) »

1. Menu ☰ → **API et services** → **Bibliothèque**.
2. Chercher **Places API (New)** — attention, prendre bien la version **(New)**,
   pas l'ancienne « Places API », le script utilise la nouvelle.
3. Cliquer → **Activer**.

## 4. Créer la clé

1. Menu ☰ → **API et services** → **Identifiants**.
2. **Créer des identifiants** → **Clé API**.
3. Copier la clé (elle ressemble à `AIzaSy...`).
4. Cliquer sur la clé pour la restreindre :
   - **Restrictions relatives aux applications** : laisser **Aucune**, ou
     choisir **Adresses IP** et mettre votre IP publique.
     ⚠️ Ne **pas** choisir « Sites web (référents HTTP) » : un script ne renvoie
     pas de referrer, tous les appels seraient refusés.
   - **Restrictions relatives aux API** : cocher **Restreindre la clé** et ne
     sélectionner que **Places API (New)**. Si la clé fuite, elle ne sert à rien
     d'autre.
5. **Enregistrer**. Compter une minute avant qu'elle soit active.

## 5. Poser un garde-fou sur le budget

1. Menu ☰ → **Facturation** → **Budgets et alertes** → **Créer un budget**.
2. Montant : 5 € par mois, alertes à 50 % et 100 %.

Vous serez prévenu par mail bien avant tout dérapage.

## 6. Lancer le script

```bash
cd /chemin/vers/Laverie
export GOOGLE_MAPS_API_KEY="AIzaSy...votre_cle"

# a) vérifier que la clé marche — un seul appel, gratuit
python3 scripts/enrich_google_places.py --test

# b) tout récupérer, y compris les laveries absentes de l'inventaire
python3 scripts/enrich_google_places.py --decouverte

# c) régénérer l'application
python3 scripts/build_standalone.py
```

Ouvrir `laverie-mapper.html` : les photos, notes et avis sont là.

Sur Windows (PowerShell), remplacer la ligne `export` par :
`$env:GOOGLE_MAPS_API_KEY="AIzaSy...votre_cle"`

## Ce que le script récupère, laverie par laverie

| Champ | Origine |
|---|---|
| `note_google`, `nb_avis` | note officielle et nombre exact d'avis |
| `avis[]` | jusqu'à 5 avis : auteur, note, texte, ancienneté |
| `photos[]` | jusqu'à 4 photos téléchargées dans `data/photos/`, avec attribution |
| `horaires` | horaires officiels, jour par jour |
| `telephone`, `site_web` | coordonnées de la fiche |
| `lat`, `lon` | **coordonnées GPS exactes** — remplace mes positions estimées |
| `place_id` | identifiant Google stable, réutilisable indéfiniment |
| `statut` | passe à `ferme` si Google indique une fermeture définitive |

Le gain le plus important n'est pas les photos : ce sont les **coordonnées
exactes**. Mes positions actuelles sont estimées depuis les adresses, avec
50 à 300 m d'écart possible — ce qui déforme les zones de chalandise et donc
tout le modèle de CA.

## Options

```bash
--test                    vérifie la clé, un seul appel
--decouverte              cherche en plus les laveries absentes de l'inventaire
--id laverie-de-saige     ne traite qu'un établissement
--sans-photos             ignore le téléchargement des images
```

## Si ça ne marche pas

Le script affiche un diagnostic pour les erreurs courantes. Les trois classiques :

| Message | Cause | Correctif |
|---|---|---|
| `API key not valid` | clé mal copiée, espace parasite | recopier la clé |
| `SERVICE_DISABLED` | Places API (New) non activée | étape 3 |
| `billing` / `PERMISSION_DENIED` | facturation non activée | étape 2 |
| requêtes refusées sans raison claire | clé restreinte aux référents HTTP | étape 4, restriction « Aucune » ou par IP |

## Règles d'usage Google à respecter

- Les `place_id` peuvent être conservés **sans limite de durée**.
- Les notes, avis et photos ne doivent **pas être conservés au-delà de 30 jours** :
  relancer le script périodiquement plutôt que traiter le fichier comme une base
  définitive. Un rappel trimestriel est de toute façon utile — les notes bougent.
- Toute photo affichée doit l'être **avec son attribution** : le script enregistre
  les auteurs et l'application les affiche sous la galerie.
- Ne pas récupérer les pages Google Maps par scraping : c'est contraire aux
  conditions d'utilisation, et les photos sont protégées. L'API est la voie propre.
