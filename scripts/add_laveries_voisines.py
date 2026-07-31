#!/usr/bin/env python3
"""Ajoute les laveries des communes voisines situées dans l'emprise de la demande.

POURQUOI C'EST INDISPENSABLE APRÈS L'IMPORT INSEE

Le carroyage couvre un rectangle qui déborde largement sur Talence, Mérignac,
Gradignan et Bordeaux : ~157 000 habitants pour 66 000 à Pessac. Si la demande
inclut ces communes mais que la concurrence s'arrête à la limite communale, le
modèle voit des zones désertes là où il y a en réalité des laveries — et les
bords de la carte ressortent faussement attractifs.

Ces laveries sont marquées `hors_commune: true`. Elles comptent comme
concurrentes mais sont exclues des statistiques de Pessac et du contrôle de
fiabilité, qui doivent rester sur le périmètre étudié.

    export GOOGLE_MAPS_API_KEY="votre_cle"
    python3 scripts/add_laveries_voisines.py            # propose
    python3 scripts/add_laveries_voisines.py --ecrire   # ajoute à l'inventaire
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data" / "laveries.json"
API = "https://places.googleapis.com/v1"
CODE_POSTAL_VILLE = "33600"

# Même emprise que scripts/import_insee_carreaux.py : la concurrence doit couvrir
# exactement la zone d'où vient la demande.
RESTRICTION = {"rectangle": {
    "low": {"latitude": 44.745, "longitude": -0.760},
    "high": {"latitude": 44.830, "longitude": -0.585},
}}
CHAMPS = ("places.id,places.displayName,places.formattedAddress,places.location,"
          "places.rating,places.userRatingCount,places.regularOpeningHours,"
          "places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus")

REQUETES = ["laverie automatique", "laverie libre service", "lavomatic", "laverie"]

# Enseignes connues, pour distinguer chaîne et indépendant.
ENSEIGNES = ["au fil du linge", "wash", "revolution laundry", "speed queen",
             "lav'pro", "washndry", "wash'n dry"]


def chercher(requete, cle):
    corps = {"textQuery": requete, "languageCode": "fr", "maxResultCount": 20,
             "locationRestriction": RESTRICTION, "includedType": "laundry"}
    req = urllib.request.Request(
        f"{API}/places:searchText", data=json.dumps(corps).encode(),
        headers={"X-Goog-Api-Key": cle, "Content-Type": "application/json",
                 "X-Goog-FieldMask": CHAMPS}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("places") or []
    except urllib.error.HTTPError as e:
        print(f"  ⚠ HTTP {e.code} : {e.read().decode(errors='replace')[:200]}",
              file=sys.stderr)
        return []


def enseigne_de(nom):
    bas = nom.lower()
    for e in ENSEIGNES:
        if e in bas:
            return nom.split("—")[0].strip()[:40]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ecrire", action="store_true", help="ajouter à data/laveries.json")
    args = ap.parse_args()

    cle = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cle:
        sys.exit("❌ GOOGLE_MAPS_API_KEY absente. Voir GOOGLE_API.md.")

    inventaire = json.loads(DATA.read_text(encoding="utf-8"))
    connus = {l.get("place_id") for l in inventaire["laveries"] if l.get("place_id")}

    trouves = {}
    for r in REQUETES:
        for p in chercher(r, cle):
            trouves.setdefault(p["id"], p)

    nouvelles, ecartees = [], []
    for p in trouves.values():
        nom = (p.get("displayName") or {}).get("text", "")
        adresse = p.get("formattedAddress", "")
        if p["id"] in connus:
            continue
        if CODE_POSTAL_VILLE in adresse:
            ecartees.append(f"{nom} — déjà dans le périmètre Pessac")
            continue
        # Un pressing est un dépôt avec personnel : autre métier, pas un concurrent.
        if "pressing" in nom.lower() and "laverie" not in nom.lower():
            ecartees.append(f"{nom} — pressing (autre métier)")
            continue
        if p.get("businessStatus") == "CLOSED_PERMANENTLY":
            ecartees.append(f"{nom} — fermé définitivement")
            continue

        loc = p["location"]
        ens = enseigne_de(nom)
        oh = (p.get("regularOpeningHours") or {}).get("weekdayDescriptions") or []
        commune = adresse.split(",")[-2].strip() if adresse.count(",") >= 2 else ""
        nouvelles.append({
            "id": "voisine-" + p["id"][-10:].lower(),
            "nom": f"{nom} ({commune})",
            "adresse": adresse,
            "quartier": None,
            "lat": loc["latitude"], "lon": loc["longitude"],
            "coord_precision": "google",
            "type": "chaine" if ens else "independant",
            "enseigne": ens,
            "statut": "actif",
            "hors_commune": True,
            "telephone": p.get("nationalPhoneNumber"),
            "site_web": None,
            "surface_m2": None, "nb_lave_linge": None, "nb_seche_linge": None,
            "nb_lave_linge_hs": None, "nb_seche_linge_hs": None,
            "prix_cycle_8kg": None,
            "horaires": " ; ".join(oh) or None,
            "ouvert_24_7": False,
            "note_google": p.get("rating"),
            "nb_avis": p.get("userRatingCount"),
            "note_source": "API Google Places (officiel)",
            "note_fiabilite": "officielle",
            "place_id": p["id"],
            "google_maps_url": p.get("googleMapsUri"),
            "photos": [], "avis": [],
            "acces": {"parking": None, "arret_tc_a_moins_300m": None,
                      "generateurs_flux": []},
            "sources": ["Google Places"],
            "notes_terrain": "Commune voisine. Comptée comme concurrente parce que "
                             "l'emprise de la demande dépasse Pessac, mais exclue des "
                             "statistiques et du contrôle de fiabilité de la commune.",
            "a_verifier": True,
        })

    nouvelles.sort(key=lambda l: -(l.get("nb_avis") or 0))
    print(f"\n{len(nouvelles)} laverie(s) voisine(s) à ajouter :\n")
    for l in nouvelles:
        print(f"  {l['nom'][:52]:<54} {str(l.get('note_google') or '—'):>4}"
              f" / {str(l.get('nb_avis') or '—'):<4} avis")
    if ecartees:
        print(f"\n{len(ecartees)} écartée(s) :")
        for e in ecartees:
            print(f"  − {e}")

    if not args.ecrire:
        print("\nRien écrit — relancez avec --ecrire pour les ajouter.")
        return

    inventaire["laveries"].extend(nouvelles)
    inventaire["meta"]["perimetre"] = (
        "L'inventaire contient les laveries de Pessac ET celles des communes "
        "voisines situées dans l'emprise du carroyage INSEE (marquées "
        "hors_commune). Ces dernières comptent comme concurrentes mais sont "
        "exclues des statistiques et du contrôle de fiabilité de Pessac.")
    DATA.write_text(json.dumps(inventaire, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    print(f"\n✅ {len(nouvelles)} laveries ajoutées → {DATA}")
    print("   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
