#!/usr/bin/env python3
"""Recale les centroïdes de quartiers sur leur position réelle (Google Places).

    export GOOGLE_MAPS_API_KEY="votre_cle"
    python3 scripts/geocode_quartiers.py              # propose, n'écrit rien
    python3 scripts/geocode_quartiers.py --appliquer  # écrit data/quartiers.json

Pourquoi c'est important : les positions des laveries sont exactes depuis
l'enrichissement Google, mais la DEMANDE reste portée par des centroïdes de
quartiers estimés à la main. L'enrichissement a montré que certains étaient
décalés de plus d'un kilomètre, ce qui déforme tout le calcul de chalandise.

Le script ne remplace pas le carroyage INSEE 200 m — il corrige seulement les
positions les plus fausses en attendant. Il affiche systématiquement l'écart
proposé : au-delà de ~1,5 km, vérifiez à la main avant d'appliquer, un nom de
quartier pouvant tomber sur un commerce homonyme.
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
DATA = RACINE / "data" / "quartiers.json"
API = "https://places.googleapis.com/v1"
VILLE = "Pessac"

RESTRICTION = {"rectangle": {
    "low": {"latitude": 44.750, "longitude": -0.750},
    "high": {"latitude": 44.825, "longitude": -0.590},
}}
CHAMPS = "places.id,places.displayName,places.formattedAddress,places.location"

# Certains quartiers se repèrent mieux par un équipement structurant que par
# leur nom seul, trop générique pour Google.
REQUETES = {
    "centre-bourg": "Hôtel de ville de Pessac",
    "saige": "Centre commercial Saige Formanoir Pessac",
    "campus": "Université de Bordeaux campus Pessac",
    "france-alouette": "Gare de Pessac Alouette France",
    "bersol": "Zone industrielle Bersol Pessac",
    "toctoucau": "Toctoucau Pessac",
    "magonty": "Magonty Pessac",
    "cap-de-bos": "Centre commercial Cap de Bos Pessac",
    "3m-bourgailh": "Parc du Bourgailh Pessac",
    "noes": "Noès Pessac",
    "verthamon": "Château Haut-Brion Pessac",
    "le-monteil": "Le Monteil Pessac",
    "brivazac-candau": "Brivazac Pessac",
    "casino": "Quartier Casino Pessac",
    "arago-chataigneraie": "La Châtaigneraie Pessac",
}


def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def chercher(requete, cle):
    corps = {"textQuery": requete, "languageCode": "fr",
             "maxResultCount": 1, "locationRestriction": RESTRICTION}
    req = urllib.request.Request(
        f"{API}/places:searchText", data=json.dumps(corps).encode(),
        headers={"X-Goog-Api-Key": cle, "Content-Type": "application/json",
                 "X-Goog-FieldMask": CHAMPS}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            places = json.load(r).get("places") or []
            return places[0] if places else None
    except urllib.error.HTTPError as e:
        print(f"    ⚠ HTTP {e.code} : {e.read().decode(errors='replace')[:200]}",
              file=sys.stderr)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--appliquer", action="store_true",
                    help="écrire les nouvelles positions dans data/quartiers.json")
    ap.add_argument("--seuil", type=float, default=2500,
                    help="écart max accepté en mètres (défaut 2500)")
    args = ap.parse_args()

    cle = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cle:
        sys.exit("❌ GOOGLE_MAPS_API_KEY absente. Voir GOOGLE_API.md.")

    d = json.loads(DATA.read_text(encoding="utf-8"))
    print(f"{'quartier':<34} {'écart':>8}  {'position proposée':<24} lieu retenu")
    print("-" * 108)

    retenus = 0
    for q in d["quartiers"]:
        requete = REQUETES.get(q["id"], f"{q['nom']} {VILLE}")
        p = chercher(requete, cle)
        time.sleep(0.25)
        if not p:
            print(f"{q['nom'][:33]:<34} {'—':>8}  introuvable")
            continue
        loc = p["location"]
        ecart = distance_m(q["lat"], q["lon"], loc["latitude"], loc["longitude"])
        nom = (p.get("displayName") or {}).get("text", "?")
        marque = "  " if ecart <= args.seuil else " ⚠"
        print(f"{q['nom'][:33]:<34} {ecart:>7.0f}m{marque} "
              f"{loc['latitude']:.5f}, {loc['longitude']:.5f}   {nom[:40]}")
        if ecart <= args.seuil:
            q["_lat_proposee"], q["_lon_proposee"] = loc["latitude"], loc["longitude"]
            retenus += 1

    if not args.appliquer:
        print(f"\n{retenus} position(s) retenue(s). Rien n'a été écrit — "
              f"relancez avec --appliquer pour valider.")
        return

    for q in d["quartiers"]:
        if "_lat_proposee" in q:
            q["lat"] = round(q.pop("_lat_proposee"), 5)
            q["lon"] = round(q.pop("_lon_proposee"), 5)
            q["position_source"] = "Google Places"
    DATA.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n✅ {retenus} centroïde(s) recalé(s) → {DATA}")
    print("   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
