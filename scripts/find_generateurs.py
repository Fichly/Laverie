#!/usr/bin/env python3
"""Localise les GÉNÉRATEURS DE DEMANDE : résidences étudiantes, logement social,
grands ensembles — les lieux où se concentrent les ménages sans lave-linge.

    export GOOGLE_MAPS_API_KEY="votre_cle"
    python3 scripts/find_generateurs.py                                  # propose
    python3 scripts/find_generateurs.py --ecrire                         # enregistre
    python3 scripts/find_generateurs.py --type residence_etudiante --ecrire

Le balayage couvre les 28 communes en 12 tuiles : l'API plafonne chaque
recherche à ~20 résultats, une requête unique sur la métropole raterait
l'essentiel. Comptez ~150 requêtes pour les trois familles, une cinquantaine
pour les seules résidences étudiantes.

Les générateurs déjà enregistrés sont CONSERVÉS avec leurs corrections : le
nombre de logements saisi à la main est le travail le plus coûteux du projet, un
nouveau balayage ne doit jamais l'écraser.

Pourquoi c'est le chantier le plus utile : le modèle répartit aujourd'hui la
demande sur 15 centroïdes de quartiers aux populations estimées, et le contrôle
de fiabilité montre qu'il n'explique pas les laveries existantes. Une résidence
universitaire de 400 logements ou une barre HLM de 200 appartements sont des
concentrations de demande bien plus précises et bien mieux localisées qu'un
centroïde de quartier.

Le nombre de logements n'est pas fourni par Google : il est estimé par défaut
selon le type et DOIT être corrigé à la main (ou relevé sur place). C'est la
position qui fait la valeur de ce fichier, pas le volume.
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "data" / "generateurs.json"
API = "https://places.googleapis.com/v1"

# Même emprise que le carroyage INSEE et le balayage des laveries : la demande
# et l'offre doivent décrire exactement le même territoire.
EMPRISE = {"sud": 44.700, "nord": 45.020, "ouest": -0.820, "est": -0.440}
TUILES_X, TUILES_Y = 4, 3


def tuiles():
    """L'API plafonne chaque recherche à ~20 résultats : une requête unique sur
    la métropole raterait l'essentiel. On découpe donc l'emprise."""
    d_lat = (EMPRISE["nord"] - EMPRISE["sud"]) / TUILES_Y
    d_lon = (EMPRISE["est"] - EMPRISE["ouest"]) / TUILES_X
    for j in range(TUILES_Y):
        for i in range(TUILES_X):
            yield {"rectangle": {
                "low": {"latitude": EMPRISE["sud"] + j * d_lat,
                        "longitude": EMPRISE["ouest"] + i * d_lon},
                "high": {"latitude": EMPRISE["sud"] + (j + 1) * d_lat,
                         "longitude": EMPRISE["ouest"] + (i + 1) * d_lon},
            }}


def dans_emprise(lat, lon):
    return (EMPRISE["sud"] <= lat <= EMPRISE["nord"]
            and EMPRISE["ouest"] <= lon <= EMPRISE["est"])
CHAMPS = ("places.id,places.displayName,places.formattedAddress,places.location,"
          "places.primaryTypeDisplayName")
# Chaque famille porte son profil de demande : part de ménages sans lave-linge et
# nombre de logements retenu par défaut faute de source ouverte.
FAMILLES = [
    {
        "cle": "residence_etudiante",
        "libelle": "Résidence étudiante",
        # Génériques : balayées dans chacune des 12 tuiles de la métropole.
        "requetes": [
            "résidence universitaire", "résidence étudiante",
            "CROUS résidence", "logement étudiant", "studios étudiants",
        ],
        # Fines : enseignes et adresses connues, lancées une seule fois.
        "requetes_fines": [
            "résidence Les Estudines Bordeaux", "Yugo Bordeaux",
            "Nemea Appart'Etud Bordeaux", "Studea Bordeaux",
            "résidence universitaire Talence", "CROUS Bordeaux Aquitaine résidence",
        ],
        "part_sans_lave_linge": 0.55,
        "logements_defaut": 200,
        "_justification": "Studios et T1 très majoritairement non équipés. La part de "
                          "13,7 % de moins de 30 ans sans machine (Businesscoot) est une "
                          "moyenne nationale : en résidence étudiante meublée, l'absence "
                          "de lave-linge individuel est la règle, d'où une part très "
                          "supérieure. Valeur à confirmer sur le terrain.",
    },
    {
        "cle": "logement_social",
        "libelle": "Logement social / grand ensemble",
        "requetes": [
            "logement social", "HLM", "résidence Domofrance",
            "Aquitanis", "Gironde Habitat",
        ],
        "requetes_fines": [
            "Clairsienne Pessac", "Mésolia Pessac",
            "résidence Saige Formanoir Pessac", "Le Monteil résidence Pessac",
            # Les grands ensembles sont éclatés en plusieurs blocs, chacun ayant sa
            # propre fiche Google. Les chercher un par un est le seul moyen de voir
            # la vraie densité : une résidence de six bâtiments n'est pas un point.
            "résidence Compostelle Pessac", "Résidence Compostelle bâtiment Pessac",
            "rue du Relais Pessac résidence", "rue Léo Ferré Pessac",
            "allée Elsa Triolet Pessac", "rue de Compostelle Pessac résidence",
            "résidence Arago Pessac", "résidence la Châtaigneraie Pessac",
            "résidence Pontet Pessac", "résidence Formanoir Pessac",
            "Bois de Saige Pessac", "Cité Frugès Pessac",
            "résidence Alouette Pessac", "résidence Haut Lévêque Pessac",
        ],
        "part_sans_lave_linge": 0.12,
        "logements_defaut": 150,
        "_justification": "Part supérieure à la moyenne nationale (4-6 %) : petits "
                          "logements, revenus contraints, rotation locative. Reste très "
                          "en dessous des résidences étudiantes.",
    },
    {
        "cle": "hebergement_tourisme",
        "libelle": "Hébergement touristique",
        "requetes": ["auberge de jeunesse", "résidence hôtelière"],
        "requetes_fines": ["camping Bordeaux Métropole"],
        "part_sans_lave_linge": 0.30,
        "logements_defaut": 60,
        "_justification": "Clientèle de passage sans équipement, mais séjours courts : "
                          "contribution réelle mais modeste.",
    },
]


# Les recherches par mots-clés ramènent inévitablement des commerces et des
# services situés DANS ces quartiers plutôt que les bâtiments d'habitation
# eux-mêmes. On les écarte sur le nom.
EXCLUSIONS = [
    "pharmacie", "boulangerie", "agence", "adil", "ccas", "action sociale",
    "resto", "restaurant", "université", "siège", "maison de quartier",
    "mairie", "école", "collège", "lycée", "banque", "assurance", "bureau",
    "supermarché", "tabac", "coiffeur", "garage", "cabinet",
    # Les résidences pour personnes âgées disposent d'un service de blanchisserie
    # interne : elles ne génèrent pas de demande en laverie de ville.
    "personnes agées", "personnes âgées", "ehpad", "retraite", "seniors",
    "senioriales", "rpa ", "maison de retraite",
    # Syndics, gestionnaires et professions libérales domiciliés dans l'immeuble :
    # ils signalent bien un bâtiment d'habitation mais ne sont pas le bâtiment.
    "synd", "copro", "location", "immobilier", "notaire", "médecin", "téléconsultation",
    "amicale", "salle municipale", "centre social", "centre commercial", "btp",
]


def est_habitation(nom):
    n = nom.lower()
    if any(x in n for x in EXCLUSIONS):
        return False
    # Un nom réduit au code postal ou à la ville n'identifie aucun bâtiment.
    if len(n.strip()) < 4 or n.strip().isdigit():
        return False
    return True


def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def chercher(requete, cle, restriction):
    corps = {"textQuery": requete, "languageCode": "fr",
             "maxResultCount": 20, "locationRestriction": restriction}
    req = urllib.request.Request(
        f"{API}/places:searchText", data=json.dumps(corps).encode(),
        headers={"X-Goog-Api-Key": cle, "Content-Type": "application/json",
                 "X-Goog-FieldMask": CHAMPS}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("places") or []
    except urllib.error.HTTPError as e:
        print(f"    ⚠ HTTP {e.code} : {e.read().decode(errors='replace')[:180]}",
              file=sys.stderr)
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ecrire", action="store_true", help="écrire data/generateurs.json")
    ap.add_argument("--type", choices=[f["cle"] for f in FAMILLES],
                    help="ne chercher qu'une famille (moins de requêtes, moins cher)")
    args = ap.parse_args()

    cle = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cle:
        sys.exit("❌ GOOGLE_MAPS_API_KEY absente. Voir GOOGLE_API.md.")

    familles = [f for f in FAMILLES if not args.type or f["cle"] == args.type]

    # On repart de l'existant : les nombres de logements corrigés à la main sont
    # le travail le plus coûteux du projet, il ne doit jamais être écrasé par un
    # nouveau balayage.
    existants = {}
    if SORTIE.exists():
        for g in json.loads(SORTIE.read_text(encoding="utf-8")).get("generateurs", []):
            if g.get("place_id"):
                existants[g["place_id"]] = g
        print(f"{len(existants)} générateur(s) déjà connus — ils seront conservés "
              "avec leurs corrections.\n")

    trouves, ecartes, n_req = dict(existants), 0, 0
    for fam in familles:
        print(f"\n🔍 {fam['libelle']}")
        # Les requêtes génériques balaient les 12 tuiles ; les fines, une seule
        # fois sur l'emprise entière (elles visent une enseigne précise).
        emprise_totale = {"rectangle": {
            "low": {"latitude": EMPRISE["sud"], "longitude": EMPRISE["ouest"]},
            "high": {"latitude": EMPRISE["nord"], "longitude": EMPRISE["est"]}}}
        plan = [(r, t) for t in tuiles() for r in fam["requetes"]]
        plan += [(r, emprise_totale) for r in fam.get("requetes_fines", [])]

        nouveaux = 0
        for requete, restriction in plan:
            n_req += 1
            for p in chercher(requete, cle, restriction):
                loc = p.get("location") or {}
                lat, lon = loc.get("latitude"), loc.get("longitude")
                if lat is None or not dans_emprise(lat, lon):
                    ecartes += 1
                    continue
                if p["id"] in trouves:
                    continue
                nom = (p.get("displayName") or {}).get("text", "")
                if not est_habitation(nom):
                    ecartes += 1
                    continue
                # Deux fiches Google peuvent viser le même bâtiment.
                if any(distance_m(lat, lon, g["lat"], g["lon"]) < 60
                       for g in trouves.values()):
                    ecartes += 1
                    continue
                trouves[p["id"]] = {
                    "id": "gen-" + p["id"][-10:].lower(),
                    "nom": nom or "?",
                    "adresse": p.get("formattedAddress", ""),
                    "lat": lat, "lon": lon,
                    "type": fam["cle"],
                    "type_google": (p.get("primaryTypeDisplayName") or {}).get("text"),
                    "logements": fam["logements_defaut"],
                    "logements_source": "valeur par défaut — À CORRIGER",
                    "part_sans_lave_linge": fam["part_sans_lave_linge"],
                    "place_id": p["id"],
                }
                nouveaux += 1
                print(f"    + {nom[:50]:<52} {p.get('formattedAddress','')[:42]}")
            time.sleep(0.2)
        print(f"    → {nouveaux} nouveau(x)")

    print(f"\n{n_req} requêtes envoyées.")
    from collections import Counter
    par_type = Counter(g["type"] for g in trouves.values())
    print(f"{len(trouves)} générateur(s) au total, {ecartes} écarté(s) "
          "(hors emprise, doublon, ou pas un logement) :")
    for cle, n in par_type.most_common():
        libelle = next((f["libelle"] for f in FAMILLES if f["cle"] == cle), cle)
        print(f"   {n:>4}  {libelle}")

    if not args.ecrire:
        print("Rien écrit — relancez avec --ecrire pour enregistrer.")
        return

    SORTIE.write_text(json.dumps({
        "meta": {
            "territoire": "Bordeaux Métropole",
            "emprise": EMPRISE,
            "source": "Google Places — balayage par tuiles, par familles de "
                      "générateurs de demande.",
            "avertissement": "Les POSITIONS viennent de Google et sont fiables. Le nombre de "
                             "logements est une valeur par défaut par famille, PAS une donnée "
                             "mesurée : à corriger bâtiment par bâtiment (bailleur, CROUS, "
                             "relevé terrain) avant toute exploitation.",
            "profils": {f["cle"]: {"libelle": f["libelle"],
                                   "part_sans_lave_linge": f["part_sans_lave_linge"],
                                   "justification": f["_justification"]} for f in FAMILLES},
        },
        "generateurs": sorted(trouves.values(), key=lambda g: (g["type"], g["nom"])),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✅ → {SORTIE}")


if __name__ == "__main__":
    main()
