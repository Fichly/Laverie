#!/usr/bin/env python3
"""Synchronise l'inventaire des laveries avec OpenStreetMap (API Overpass).

À exécuter en local (nécessite un accès internet libre) :

    python3 scripts/sync_osm.py

Le script interroge Overpass sur la zone de Pessac et environs, puis fusionne
les résultats dans data/laveries.json :
  - une laverie OSM absente de l'inventaire est ajoutée (a_verifier=True)
  - une laverie existante située à moins de 150 m d'un point OSM voit ses
    coordonnées recalées sur OSM (coord_precision="osm")

Il n'écrase jamais les champs renseignés à la main (machines, prix, notes...).
"""

import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

BBOX = (44.75, -0.76, 44.84, -0.55)  # sud, ouest, nord, est — Pessac + franges
OVERPASS = "https://overpass-api.de/api/interpreter"
DATA = Path(__file__).resolve().parent.parent / "data" / "laveries.json"

QUERY = f"""
[out:json][timeout:60];
(
  nwr["shop"="laundry"]({','.join(map(str, BBOX))});
  nwr["amenity"="washing_machine"]({','.join(map(str, BBOX))});
);
out center tags;
"""


def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def fetch_osm():
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": QUERY}).encode(),
        headers={"User-Agent": "laverie-mapper/0.1 (etude de marche laveries Pessac)"},
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.load(resp)


def main():
    inventaire = json.loads(DATA.read_text(encoding="utf-8"))
    laveries = inventaire["laveries"]

    osm = fetch_osm()
    ajouts, recalages = 0, 0

    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None:
            continue

        proche = min(laveries, key=lambda l: distance_m(lat, lon, l["lat"], l["lon"]))
        d = distance_m(lat, lon, proche["lat"], proche["lon"])

        if d < 150:
            if proche.get("coord_precision") != "osm":
                proche["lat"], proche["lon"] = lat, lon
                proche["coord_precision"] = "osm"
                proche.setdefault("sources", []).append(f"OSM {el['type']}/{el['id']}")
                recalages += 1
            continue

        nom = tags.get("name", "Laverie (nom inconnu)")
        laveries.append({
            "id": f"osm-{el['type']}-{el['id']}",
            "nom": nom,
            "adresse": " ".join(filter(None, [
                tags.get("addr:housenumber"), tags.get("addr:street"),
                tags.get("addr:postcode"), tags.get("addr:city"),
            ])) or "adresse à relever",
            "quartier": None,
            "lat": lat,
            "lon": lon,
            "coord_precision": "osm",
            "type": "chaine" if tags.get("brand") else "independant",
            "enseigne": tags.get("brand"),
            "statut": "actif",
            "surface_m2": None,
            "nb_lave_linge": None,
            "nb_seche_linge": None,
            "prix_cycle_8kg": None,
            "horaires": tags.get("opening_hours"),
            "ouvert_24_7": tags.get("opening_hours") == "24/7",
            "note_google": None,
            "nb_avis": None,
            "acces": {"parking": None, "arret_tc_a_moins_300m": None, "generateurs_flux": []},
            "sources": [f"OSM {el['type']}/{el['id']}"],
            "notes_terrain": "",
            "a_verifier": True,
        })
        ajouts += 1

    DATA.write_text(json.dumps(inventaire, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    print(f"OSM : {len(osm.get('elements', []))} objets — {ajouts} ajoutés, "
          f"{recalages} positions recalées → {DATA}")


if __name__ == "__main__":
    main()
