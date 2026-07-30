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

# Biais géographique : sans lui, une recherche « Laverie de Saige » peut renvoyer
# un établissement d'une autre ville. On contraint les résultats autour de Pessac.
CENTRE_VILLE = {"latitude": 44.806, "longitude": -0.631}
RAYON_BIAIS_M = 8000.0
BIAIS = {"circle": {"center": CENTRE_VILLE, "radius": RAYON_BIAIS_M}}

CHAMPS_RECHERCHE = "places.id,places.displayName,places.formattedAddress,places.location"
CHAMPS_DETAIL = ",".join([
    "id", "displayName", "formattedAddress", "location", "rating",
    "userRatingCount", "nationalPhoneNumber", "websiteUri",
    "regularOpeningHours", "reviews", "photos", "googleMapsUri",
    "businessStatus", "primaryTypeDisplayName",
])


# Messages d'aide pour les erreurs qui bloquent le plus souvent au premier essai.
DIAGNOSTICS = {
    "SERVICE_DISABLED": "L'API « Places API (New) » n'est pas activée sur ce projet.\n"
                        "     → console.cloud.google.com → API et services → Bibliothèque →\n"
                        "       chercher « Places API (New) » → Activer.",
    "API key not valid": "Clé invalide ou mal copiée (attention aux espaces).",
    "REQUEST_DENIED": "Clé refusée : vérifiez les restrictions de la clé.",
    "billing": "La facturation n'est pas activée sur le projet. Elle est obligatoire\n"
               "     même pour rester dans le quota gratuit — aucune somme ne sera\n"
               "     prélevée à l'échelle d'une ville.",
    "referer": "Votre clé est restreinte à des sites web (HTTP referrer).\n"
               "     Un script n'envoie pas de referrer : créez une clé sans restriction\n"
               "     d'application, ou restreinte par adresse IP.",
}


def diagnostiquer(detail):
    for motif, aide in DIAGNOSTICS.items():
        if motif.lower() in detail.lower():
            return aide
    return None


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
        detail = e.read().decode(errors="replace")[:600]
        print(f"    ⚠ HTTP {e.code} : {detail}", file=sys.stderr)
        aide = diagnostiquer(detail)
        if aide:
            print(f"     ↳ {aide}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"    ⚠ réseau indisponible : {e.reason}", file=sys.stderr)
        return None


def tester_cle(cle):
    """Valide la clé avec un seul appel, avant de lancer tout l'inventaire."""
    print("🔑 Test de la clé API…")
    res = appel(f"{API}/places:searchText", cle,
                {"textQuery": f"laverie {VILLE}", "languageCode": "fr",
                 "maxResultCount": 1, "locationBias": BIAIS},
                {"X-Goog-FieldMask": CHAMPS_RECHERCHE})
    if res is None:
        print("❌ La clé ne fonctionne pas — voir le diagnostic ci-dessus.")
        return False
    trouves = res.get("places") or []
    print(f"✅ Clé valide. Exemple de résultat : "
          f"{(trouves[0].get('displayName') or {}).get('text') if trouves else 'aucun'}")
    return True


def chercher_place(nom, adresse, cle):
    """Retrouve l'identifiant Google d'une laverie à partir de son nom et adresse."""
    essais = [
        f"{nom} {adresse}",
        f"laverie {adresse}",   # le nom d'annuaire est parfois faux, l'adresse rarement
    ]
    for requete in essais:
        res = appel(f"{API}/places:searchText", cle,
                    {"textQuery": requete, "languageCode": "fr",
                     "maxResultCount": 1, "locationBias": BIAIS},
                    {"X-Goog-FieldMask": CHAMPS_RECHERCHE})
        places = (res or {}).get("places") or []
        if places:
            return places[0]
    return None


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
    # Plusieurs formulations : Google ne renvoie pas les mêmes résultats selon les mots.
    requetes = [
        f"laverie automatique {VILLE}",
        f"laverie libre service {VILLE}",
        f"lavomatic {VILLE}",
        f"blanchisserie libre service {VILLE}",
    ]
    trouves = {}
    for requete in requetes:
        res = appel(f"{API}/places:searchText", cle,
                    {"textQuery": requete, "languageCode": "fr",
                     "maxResultCount": 20, "locationBias": BIAIS,
                     "includedType": "laundry"},
                    {"X-Goog-FieldMask": CHAMPS_RECHERCHE})
        for p in (res or {}).get("places", []):
            trouves.setdefault(p["id"], p)

    nouveaux = []
    for p in trouves.values():
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
    ap.add_argument("--test", action="store_true",
                    help="vérifier seulement que la clé fonctionne (1 seul appel)")
    args = ap.parse_args()

    cle = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cle:
        sys.exit("❌ Variable GOOGLE_MAPS_API_KEY absente.\n"
                 "   export GOOGLE_MAPS_API_KEY=\"votre_cle\"\n"
                 "   Clé à créer sur https://console.cloud.google.com (activer « Places API (New) »).\n"
                 "   Voir le pas-à-pas complet dans GOOGLE_API.md.")

    if not tester_cle(cle):
        sys.exit(1)
    if args.test:
        print("\n✅ Tout est prêt. Lancez maintenant :\n"
              "   python3 scripts/enrich_google_places.py --decouverte")
        return

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
