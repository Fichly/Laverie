#!/usr/bin/env python3
"""Importe les résidences universitaires CROUS depuis le flux officiel.

POURQUOI CETTE SOURCE PLUTÔT QUE GOOGLE

Les résidences étudiantes sont le premier générateur de demande d'une laverie :
un studio meublé n'a pratiquement jamais de lave-linge. Jusqu'ici on les
cherchait via Google Places — ce qui coûte des appels, rate les résidences mal
référencées et ne donne aucun nombre de logements.

Le CNOUS publie la liste de ses résidences, académie par académie, en accès
libre et sans clé. C'est la source de référence : positions officielles, et
souvent la capacité d'accueil.

    python3 scripts/import_crous.py                    # académie de Bordeaux
    python3 scripts/import_crous.py --academie lyon --ecrire
    python3 scripts/import_crous.py --fichier ~/Downloads/bordeaux-logement.xml
    python3 scripts/import_crous.py --diagnostic       # montre le XML brut

CE QUE CE SCRIPT NE COUVRE PAS

Seulement le parc PUBLIC. Les résidences privées — Studéa, Les Estudines, Yugo,
Nemea — n'y figurent pas, et elles pèsent lourd dans une métropole étudiante.
Pour celles-là, le balayage Google reste nécessaire :

    python3 scripts/find_generateurs.py --type residence_etudiante --ecrire

Les deux sources se complètent et se dédoublonnent : un même bâtiment trouvé par
les deux n'est compté qu'une fois.
"""

import argparse
import json
import math
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reseau                                              # noqa: E402

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "data" / "generateurs.json"

FLUX = "https://webservices-v2.crous-mobile.fr/feed/{a}/{a}-logement.xml"
FLUX_SECOURS = "http://webservices-v2.crous-mobile.fr:8080/feed/{a}/{a}-logement.xml"

# Même emprise que le carroyage INSEE et le balayage des laveries. Le flux couvre
# toute l'académie (Gironde, Dordogne, Lot-et-Garonne…) : sans ce filtre on
# importerait des résidences de Périgueux dans une étude sur la métropole.
EMPRISE = {"sud": 44.700, "nord": 45.020, "ouest": -0.820, "est": -0.440}

# Le flux a changé de forme au fil des versions. Plutôt que de viser un chemin
# précis — qui casserait silencieusement à la prochaine — on cherche les balises
# par nom, à n'importe quelle profondeur.
CLES_NOM = ("title", "nom", "name", "libelle", "residence", "designation")
CLES_ADRESSE = ("address", "adresse", "location", "rue", "voie")
CLES_LAT = ("latitude", "lat")
CLES_LON = ("longitude", "lng", "lon", "long")
CLES_CAPACITE = ("capacity", "capacite", "nb_logements", "logements",
                 "places", "nombre_logements")

PART_SANS_LAVE_LINGE = 0.55      # même profil que les autres résidences étudiantes
LOGEMENTS_DEFAUT = 200


def sans_ns(balise):
    """Retire l'espace de noms : {http://…}title → title."""
    return balise.split('}')[-1].lower() if '}' in balise else balise.lower()


def valeurs(element):
    """Toutes les paires (clé, valeur) d'un élément : attributs et enfants directs."""
    paires = {sans_ns(k): v for k, v in element.attrib.items()}
    for enfant in element:
        if enfant.text and enfant.text.strip():
            paires.setdefault(sans_ns(enfant.tag), enfant.text.strip())
    return paires


def premiere(paires, cles):
    for c in cles:
        if paires.get(c):
            return paires[c]
    return None


def nombre(v):
    if v is None:
        return None
    try:
        return float(str(v).replace(",", ".").strip())
    except ValueError:
        return None


def extraire(racine):
    """Renvoie les résidences du flux, quelle que soit sa structure."""
    residences = []
    for element in racine.iter():
        paires = valeurs(element)
        lat = nombre(premiere(paires, CLES_LAT))
        lon = nombre(premiere(paires, CLES_LON))
        if lat is None or lon is None:
            continue
        nom = premiere(paires, CLES_NOM)
        if not nom:
            continue
        residences.append({
            "nom": nom.strip(),
            "adresse": (premiere(paires, CLES_ADRESSE) or "").strip(),
            "lat": lat, "lon": lon,
            "capacite": nombre(premiere(paires, CLES_CAPACITE)),
            "cle": (element.attrib.get("id") or element.attrib.get("code")
                    or f"{round(lat, 5)},{round(lon, 5)}"),
        })
    return residences


def dans_emprise(r):
    return (EMPRISE["sud"] <= r["lat"] <= EMPRISE["nord"]
            and EMPRISE["ouest"] <= r["lon"] <= EMPRISE["est"])


def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def telecharger(academie):
    """Le flux existe en HTTPS et en HTTP sur port 8080 selon les académies."""
    erreurs = []
    for gabarit in (FLUX, FLUX_SECOURS):
        url = gabarit.format(a=academie)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "laverie-mapper"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read(), url
        except Exception as e:                              # noqa: BLE001
            erreurs.append(f"{url} → {e}")
            if reseau.est_erreur_certificat(e):
                sys.exit("\n" + reseau.message_certificat())
    sys.exit("❌ Flux CROUS injoignable.\n   " + "\n   ".join(erreurs)
             + "\n\n   Solution de repli : ouvrez l'URL dans votre navigateur,"
               "\n   enregistrez le fichier, puis relancez avec --fichier <chemin>.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--academie", default="bordeaux",
                    help="académie du flux CROUS (défaut : bordeaux)")
    ap.add_argument("--fichier", help="lire un XML déjà téléchargé au lieu du flux")
    ap.add_argument("--ecrire", action="store_true", help="écrire data/generateurs.json")
    ap.add_argument("--diagnostic", action="store_true",
                    help="affiche le début du XML brut et s'arrête")
    args = ap.parse_args()

    if args.fichier:
        brut, origine = Path(args.fichier).read_bytes(), args.fichier
    else:
        brut, origine = telecharger(args.academie)

    if args.diagnostic:
        print(brut[:4000].decode("utf-8", errors="replace"))
        print("\n(envoyez ce bloc si le script ne trouve rien)")
        return

    try:
        racine = ET.fromstring(brut)
    except ET.ParseError as e:
        sys.exit(f"❌ XML illisible ({e}). Relancez avec --diagnostic.")

    toutes = extraire(racine)
    if not toutes:
        sys.exit("❌ Aucune résidence reconnue dans le flux.\n"
                 "   Relancez avec --diagnostic et envoyez-moi la sortie : la\n"
                 "   structure du flux a probablement changé.")

    retenues = [r for r in toutes if dans_emprise(r)]
    print(f"Source : {origine}")
    print(f"{len(toutes)} résidences dans l'académie, "
          f"{len(retenues)} dans l'emprise étudiée.\n")

    existants = {}
    if SORTIE.exists():
        contenu = json.loads(SORTIE.read_text(encoding="utf-8"))
        meta_existante = contenu.get("meta", {})
        for g in contenu.get("generateurs", []):
            existants[g["id"]] = g
    else:
        meta_existante = {}

    # Deux sources pour un même bâtiment : on ne le compte qu'une fois. La
    # position CROUS étant officielle, elle l'emporte sur celle de Google.
    ajoutes, fusionnes = 0, 0
    for r in retenues:
        doublon = next((g for g in existants.values()
                        if distance_m(r["lat"], r["lon"], g["lat"], g["lon"]) < 80), None)
        if doublon:
            doublon["lat"], doublon["lon"] = r["lat"], r["lon"]
            doublon["source_position"] = "CROUS (officiel)"
            if r["capacite"] and doublon.get("logements_source", "").startswith("valeur"):
                doublon["logements"] = int(r["capacite"])
                doublon["logements_source"] = "CROUS (officiel)"
            fusionnes += 1
            continue
        cle = "crous-" + str(r["cle"]).replace(",", "_").replace(".", "")[-14:]
        existants[cle] = {
            "id": cle, "nom": r["nom"], "adresse": r["adresse"],
            "lat": r["lat"], "lon": r["lon"],
            "type": "residence_etudiante",
            "type_google": "Résidence universitaire CROUS",
            "logements": int(r["capacite"]) if r["capacite"] else LOGEMENTS_DEFAUT,
            "logements_source": ("CROUS (officiel)" if r["capacite"]
                                 else "valeur par défaut — À CORRIGER"),
            "part_sans_lave_linge": PART_SANS_LAVE_LINGE,
            "source_position": "CROUS (officiel)",
            "place_id": None,
        }
        ajoutes += 1
        print(f"  + {r['nom'][:50]:<52} "
              f"{(str(int(r['capacite'])) + ' log.') if r['capacite'] else '—':>10}")

    avec_capacite = sum(1 for r in retenues if r["capacite"])
    print(f"\n{ajoutes} nouvelle(s), {fusionnes} déjà connue(s) et recalée(s).")
    print(f"{avec_capacite}/{len(retenues)} avec une capacité officielle "
          f"(les autres gardent la valeur par défaut, à corriger).")

    if not args.ecrire:
        print("\nRien écrit — relancez avec --ecrire pour enregistrer.")
        return

    meta_existante["crous"] = {
        "academie": args.academie, "source": origine,
        "residences_importees": ajoutes + fusionnes,
        "avertissement": "Parc public uniquement. Les résidences privées "
                         "(Studéa, Estudines, Yugo…) viennent du balayage Google.",
    }
    SORTIE.write_text(json.dumps({
        "meta": meta_existante,
        "generateurs": sorted(existants.values(), key=lambda g: (g["type"], g["nom"])),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✅ {len(existants)} générateurs au total → {SORTIE}")
    print("   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
