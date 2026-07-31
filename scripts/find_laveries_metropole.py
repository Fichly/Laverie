#!/usr/bin/env python3
"""Recense les laveries des 28 communes de Bordeaux Métropole via Google Places.

POURQUOI UN BALAYAGE PAR TUILES

L'API Places plafonne chaque recherche à ~20 résultats : une seule requête sur
toute la métropole raterait la moitié des laveries. On découpe donc l'emprise en
tuiles, et on lance chaque requête type dans chaque tuile, avec déduplication
par identifiant Google. C'est le même principe qu'add_laveries_voisines.py, en
couvrant tout le territoire au lieu des seuls abords de Pessac.

    export GOOGLE_MAPS_API_KEY="votre_cle"
    python3 scripts/find_laveries_metropole.py            # propose
    python3 scripts/find_laveries_metropole.py --ecrire   # ajoute à l'inventaire

Coût : ~48 requêtes Text Search (4 requêtes × 12 tuiles), soit quelques
centimes, largement sous le crédit mensuel offert.

Les laveries hors Pessac restent marquées `hors_commune: true` : le périmètre
« Pessac » de l'application continue de fonctionner comme avant, et le
périmètre « Métropole » les prend toutes en compte.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data" / "laveries.json"
API = "https://places.googleapis.com/v1"
CP_PESSAC = "33600"

# Même emprise que scripts/import_insee_carreaux.py : l'offre doit couvrir
# exactement le territoire d'où vient la demande.
EMPRISE = {"sud": 44.700, "nord": 45.020, "ouest": -0.820, "est": -0.440}
TUILES_X, TUILES_Y = 4, 3

CHAMPS = ("places.id,places.displayName,places.formattedAddress,places.location,"
          "places.rating,places.userRatingCount,places.regularOpeningHours,"
          "places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus")

REQUETES = ["laverie automatique", "laverie libre service", "lavomatic", "laverie"]

ENSEIGNES = ["au fil du linge", "wash", "revolution laundry", "speed queen",
             "lav'pro", "washndry", "wash'n dry", "5asec", "laundry"]


def tuiles():
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


def chercher(requete, restriction, cle):
    corps = {"textQuery": requete, "languageCode": "fr", "maxResultCount": 20,
             "locationRestriction": restriction, "includedType": "laundry"}
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


def commune_de(adresse):
    morceaux = [m.strip() for m in adresse.split(",")]
    for m in morceaux:
        if any(c.isdigit() for c in m[:5]) and len(m) > 6:   # « 33700 Mérignac »
            return m
    return morceaux[-2] if len(morceaux) >= 2 else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ecrire", action="store_true", help="ajouter à data/laveries.json")
    args = ap.parse_args()

    cle = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cle:
        sys.exit("❌ GOOGLE_MAPS_API_KEY absente. Voir GOOGLE_API.md.")

    inventaire = json.loads(DATA.read_text(encoding="utf-8"))
    connus = {l.get("place_id") for l in inventaire["laveries"] if l.get("place_id")}

    trouves, n_req = {}, 0
    for t, restriction in enumerate(tuiles(), 1):
        for r in REQUETES:
            for p in chercher(r, restriction, cle):
                trouves.setdefault(p["id"], p)
            n_req += 1
            time.sleep(0.15)
        print(f"  tuile {t}/{TUILES_X * TUILES_Y} : {len(trouves)} laveries distinctes")

    nouvelles, ecartees = [], []
    for p in trouves.values():
        nom = (p.get("displayName") or {}).get("text", "")
        adresse = p.get("formattedAddress", "")
        if p["id"] in connus:
            continue
        if "pressing" in nom.lower() and "laverie" not in nom.lower():
            ecartees.append(f"{nom} — pressing (autre métier)")
            continue
        if p.get("businessStatus") == "CLOSED_PERMANENTLY":
            ecartees.append(f"{nom} — fermé définitivement")
            continue

        loc = p["location"]
        ens = enseigne_de(nom)
        oh = (p.get("regularOpeningHours") or {}).get("weekdayDescriptions") or []
        commune = commune_de(adresse)
        hors_pessac = CP_PESSAC not in adresse
        nouvelles.append({
            "id": "metropole-" + p["id"][-10:].lower(),
            "nom": f"{nom} ({commune})" if hors_pessac else nom,
            "adresse": adresse,
            "quartier": None,
            "lat": loc["latitude"], "lon": loc["longitude"],
            "coord_precision": "google",
            "type": "chaine" if ens else "independant",
            "enseigne": ens,
            "statut": "actif",
            "hors_commune": hors_pessac,
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
            "notes_terrain": "Recensée par le balayage métropole. Position et note "
                             "officielles Google ; machines, surface et prix à relever.",
            "a_verifier": True,
        })

    nouvelles.sort(key=lambda l: -(l.get("nb_avis") or 0))
    print(f"\n{n_req} requêtes · {len(nouvelles)} laverie(s) à ajouter :\n")
    for l in nouvelles:
        print(f"  {l['nom'][:56]:<58} {str(l.get('note_google') or '—'):>4}"
              f" / {str(l.get('nb_avis') or '—'):<5} avis")
    if ecartees:
        print(f"\n{len(ecartees)} écartée(s) :")
        for e in ecartees:
            print(f"  − {e}")

    if not args.ecrire:
        print("\nRien écrit — relancez avec --ecrire pour les ajouter.")
        return

    inventaire["laveries"].extend(nouvelles)
    inventaire["meta"]["perimetre"] = (
        "Inventaire étendu aux 28 communes de Bordeaux Métropole par balayage "
        "Google Places en tuiles. Les laveries hors Pessac sont marquées "
        "hors_commune : le périmètre « Pessac » de l'application les traite en "
        "concurrentes, le périmètre « Métropole » les intègre pleinement.")
    DATA.write_text(json.dumps(inventaire, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    print(f"\n✅ {len(nouvelles)} laveries ajoutées → {DATA}")
    print("   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
