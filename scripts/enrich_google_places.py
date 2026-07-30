#!/usr/bin/env python3
"""Enrichit l'inventaire avec les données officielles Google Places :
note, nombre d'avis, avis, horaires, téléphone, site web et photos.

    export GOOGLE_MAPS_API_KEY="votre_cle"
    python3 scripts/enrich_google_places.py            # tout l'inventaire
    python3 scripts/enrich_google_places.py --id laverie-de-saige
    python3 scripts/enrich_google_places.py --decouverte  # cherche aussi les laveries absentes

Obtenir une clé : https://console.cloud.google.com → activer « Places API (New) ».
Le quota gratuit mensuel couvre très largement l'échelle d'une ville.

POURQUOI PASSER PAR L'API plutôt que de récupérer les pages Google Maps :
le scraping de Google Maps viole les conditions d'utilisation, et les photos
sont protégées. L'API est la seule voie propre — elle fournit d'ailleurs les
mentions d'attribution obligatoires, que ce script conserve dans les données.

RÈGLES D'USAGE À RESPECTER (conditions Google) :
  - les identifiants de lieu (place_id) peuvent être conservés sans limite ;
  - les autres contenus (notes, avis, photos) ne doivent pas être conservés
    au-delà de 30 jours : relancer ce script régulièrement plutôt que de
    considérer le cache comme une base de données pérenne ;
  - toute photo affichée doit l'être avec son attribution (champ
    « attributions » enregistré ici pour chaque photo).
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data" / "laveries.json"
PHOTOS = RACINE / "data" / "photos"

API = "https://places.googleapis.com/v1"
VILLE = "Pessac 33600 France"
MAX_PHOTOS = 4          # photos téléchargées par laverie
LARGEUR_PHOTO = 800     # px

CHAMPS_RECHERCHE = "places.id,places.displayName,places.formattedAddress,places.location"
CHAMPS_DETAIL = ",".join([
    "id", "displayName", "formattedAddress", "location", "rating",
    "userRatingCount", "nationalPhoneNumber", "websiteUri",
    "regularOpeningHours", "reviews", "photos", "googleMapsUri",
    "businessStatus", "primaryTypeDisplayName",
])


def appel(url, cle, corps=None, entetes_sup=None):
    entetes = {"X-Goog-Api-Key": cle, "Content-Type": "application/json"}
    entetes.update(entetes_sup or {})
    donnees = json.dumps(corps).encode() if corps is not None else None
    req = urllib.request.Request(url, data=donnees, headers=entetes,
                                 method="POST" if corps is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        print(f"    ⚠ HTTP {e.code} : {detail}", file=sys.stderr)
        return None


def chercher_place(nom, adresse, cle):
    """Retrouve l'identifiant Google d'une laverie à partir de son nom et adresse."""
    corps = {"textQuery": f"{nom} {adresse}", "languageCode": "fr", "maxResultCount": 1}
    res = appel(f"{API}/places:searchText", cle, corps,
                {"X-Goog-FieldMask": CHAMPS_RECHERCHE})
    places = (res or {}).get("places") or []
    if not places:
        # Repli : recherche sur la seule adresse, le nom d'annuaire étant parfois faux
        corps = {"textQuery": f"laverie {adresse}", "languageCode": "fr", "maxResultCount": 1}
        res = appel(f"{API}/places:searchText", cle, corps,
                    {"X-Goog-FieldMask": CHAMPS_RECHERCHE})
        places = (res or {}).get("places") or []
    return places[0] if places else None


def detail_place(place_id, cle):
    url = f"{API}/places/{place_id}?languageCode=fr"
    return appel(url, cle, None, {"X-Goog-FieldMask": CHAMPS_DETAIL})


def telecharger_photos(detail, laverie_id, cle):
    """Télécharge les photos dans data/photos/ et renvoie leurs métadonnées."""
    PHOTOS.mkdir(parents=True, exist_ok=True)
    sorties = []
    for i, photo in enumerate((detail.get("photos") or [])[:MAX_PHOTOS]):
        nom_res = photo["name"]  # places/XXX/photos/YYY
        url = (f"{API}/{nom_res}/media?maxWidthPx={LARGEUR_PHOTO}"
               f"&skipHttpRedirect=true&key={urllib.parse.quote(cle)}")
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                info = json.load(r)
            uri = info.get("photoUri")
            if not uri:
                continue
            fichier = PHOTOS / f"{laverie_id}-{i + 1}.jpg"
            with urllib.request.urlopen(uri, timeout=45) as src, open(fichier, "wb") as dst:
                dst.write(src.read())
            sorties.append({
                "fichier": f"data/photos/{fichier.name}",
                "largeur": photo.get("widthPx"),
                "hauteur": photo.get("heightPx"),
                # Attribution OBLIGATOIRE à afficher avec la photo
                "attributions": [a.get("displayName") for a in photo.get("authorAttributions", [])],
            })
            print(f"    📷 {fichier.name}")
            time.sleep(0.2)
        except Exception as e:  # noqa: BLE001 — on continue sur les autres photos
            print(f"    ⚠ photo {i + 1} non récupérée : {e}", file=sys.stderr)
    return sorties


def horaires_fr(detail):
    oh = detail.get("regularOpeningHours") or {}
    desc = oh.get("weekdayDescriptions") or []
    return " ; ".join(desc) if desc else None


def enrichir(laverie, cle, telecharger=True):
    print(f"→ {laverie['nom']}")
    pid = laverie.get("place_id")
    if not pid:
        trouve = chercher_place(laverie["nom"], laverie["adresse"], cle)
        if not trouve:
            print("    ✗ introuvable dans Google Places")
            return False
        pid = trouve["id"]
        print(f"    place_id : {pid}")

    detail = detail_place(pid, cle)
    if not detail:
        print("    ✗ détail indisponible")
        return False

    laverie["place_id"] = detail.get("id", pid)
    laverie["google_maps_url"] = detail.get("googleMapsUri")
    laverie["nom_google"] = (detail.get("displayName") or {}).get("text")
    laverie["adresse_google"] = detail.get("formattedAddress")

    loc = detail.get("location") or {}
    if loc.get("latitude"):
        laverie["lat"] = loc["latitude"]
        laverie["lon"] = loc["longitude"]
        laverie["coord_precision"] = "google"

    if detail.get("rating") is not None:
        laverie["note_google"] = detail["rating"]
        laverie["nb_avis"] = detail.get("userRatingCount")
        laverie["note_source"] = "API Google Places (officiel)"
        laverie["note_fiabilite"] = "officielle"

    if detail.get("nationalPhoneNumber"):
        laverie["telephone"] = detail["nationalPhoneNumber"]
    if detail.get("websiteUri"):
        laverie["site_web"] = detail["websiteUri"]
    if horaires_fr(detail):
        laverie["horaires"] = horaires_fr(detail)
    if detail.get("businessStatus") == "CLOSED_PERMANENTLY":
        laverie["statut"] = "ferme"
        print("    ⚠ établissement FERMÉ DÉFINITIVEMENT d'après Google")

    laverie["avis"] = [{
        "auteur": (a.get("authorAttribution") or {}).get("displayName"),
        "note": a.get("rating"),
        "texte": (a.get("originalText") or a.get("text") or {}).get("text"),
        "date": a.get("relativePublishTimeDescription"),
        "source": "Google Places",
    } for a in (detail.get("reviews") or [])]

    if telecharger:
        photos = telecharger_photos(detail, laverie["id"], cle)
        if photos:
            laverie["photos"] = photos

    laverie["a_verifier"] = laverie.get("surface_m2") is None
    print(f"    ✓ {laverie.get('note_google')}/5 · {laverie.get('nb_avis')} avis · "
          f"{len(laverie['avis'])} avis détaillés · {len(laverie.get('photos', []))} photos")
    return True


def decouvrir(inventaire, cle):
    """Cherche des laveries de Pessac absentes de l'inventaire."""
    connus = {l.get("place_id") for l in inventaire["laveries"] if l.get("place_id")}
    corps = {"textQuery": f"laverie automatique {VILLE}", "languageCode": "fr",
             "maxResultCount": 20}
    res = appel(f"{API}/places:searchText", cle, corps,
                {"X-Goog-FieldMask": CHAMPS_RECHERCHE})
    nouveaux = []
    for p in (res or {}).get("places", []):
        if p["id"] in connus:
            continue
        nouveaux.append({
            "id": "google-" + p["id"][-12:].lower(),
            "nom": (p.get("displayName") or {}).get("text", "Laverie"),
            "adresse": p.get("formattedAddress", ""),
            "quartier": None,
            "lat": (p.get("location") or {}).get("latitude"),
            "lon": (p.get("location") or {}).get("longitude"),
            "coord_precision": "google",
            "type": "independant",
            "enseigne": None,
            "statut": "actif",
            "telephone": None, "site_web": None,
            "surface_m2": None, "nb_lave_linge": None, "nb_seche_linge": None,
            "prix_cycle_8kg": None, "horaires": None, "ouvert_24_7": False,
            "note_google": None, "nb_avis": None, "note_source": None,
            "note_fiabilite": None,
            "place_id": p["id"], "photos": [], "avis": [],
            "acces": {"parking": None, "arret_tc_a_moins_300m": None, "generateurs_flux": []},
            "sources": ["Google Places"], "notes_terrain": "Découverte via Google Places.",
            "a_verifier": True,
        })
    if nouveaux:
        print(f"\n🔍 {len(nouveaux)} laverie(s) absente(s) de l'inventaire :")
        for n in nouveaux:
            print(f"    + {n['nom']} — {n['adresse']}")
        inventaire["laveries"].extend(nouveaux)
    else:
        print("\n🔍 Aucune laverie supplémentaire trouvée.")
    return nouveaux


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", help="n'enrichir qu'une laverie (son id)")
    ap.add_argument("--decouverte", action="store_true",
                    help="chercher aussi les laveries absentes de l'inventaire")
    ap.add_argument("--sans-photos", action="store_true", help="ne pas télécharger les photos")
    args = ap.parse_args()

    cle = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cle:
        sys.exit("❌ Variable GOOGLE_MAPS_API_KEY absente.\n"
                 "   export GOOGLE_MAPS_API_KEY=\"votre_cle\"\n"
                 "   Clé à créer sur https://console.cloud.google.com (activer « Places API (New) »).")

    inventaire = json.loads(DATA.read_text(encoding="utf-8"))

    if args.decouverte:
        decouvrir(inventaire, cle)

    cibles = [l for l in inventaire["laveries"] if not args.id or l["id"] == args.id]
    if not cibles:
        sys.exit(f"❌ Aucune laverie avec l'id « {args.id} ».")

    ok = 0
    for laverie in cibles:
        if enrichir(laverie, cle, telecharger=not args.sans_photos):
            ok += 1
        time.sleep(0.3)

    inventaire["meta"]["derniere_maj_google"] = time.strftime("%Y-%m-%d")
    inventaire["meta"]["avertissement"] = (
        "Notes, avis et photos issus de l'API Google Places. Conditions Google : "
        "ne pas conserver ces contenus au-delà de 30 jours — relancer "
        "scripts/enrich_google_places.py régulièrement."
    )
    DATA.write_text(json.dumps(inventaire, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    print(f"\n✅ {ok}/{len(cibles)} laverie(s) enrichie(s) → {DATA}")
    print("   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
