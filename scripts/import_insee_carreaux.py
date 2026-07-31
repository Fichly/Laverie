#!/usr/bin/env python3
"""Importe les données carroyées INSEE Filosofi (mailles de 200 m) et les
convertit en couche de demande pour l'outil.

C'est le correctif de fond du modèle : il remplace 15 centroïdes de quartiers
aux populations estimées par la population réellement observée, maille par
maille. Tant qu'il n'est pas fait, le classement des zones reste indicatif.

USAGE
    # 1. Télécharger le fichier (voir DONNEES_INSEE.md pour le lien exact)
    # 2. Le placer dans data/source/ (CSV, ou CSV extrait du .zip)
    python3 scripts/import_insee_carreaux.py data/source/carreaux_200m_met.csv
    python3 scripts/build_standalone.py

Le script détecte automatiquement les noms de colonnes : l'INSEE les fait varier
d'un millésime à l'autre (2019, 2021…). Il n'écrit que les carreaux situés dans
l'emprise de la ville pilote.

AUCUNE DÉPENDANCE : la conversion depuis la projection européenne LAEA
(EPSG:3035) vers les coordonnées géographiques est implémentée ici, pour ne pas
imposer l'installation de pyproj ou de GDAL.
"""

import argparse
import csv
import json
import math
import re
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "data" / "carreaux.json"

# Emprise de la ville pilote (Pessac), en degrés.
EMPRISE = {"sud": 44.745, "nord": 44.830, "ouest": -0.760, "est": -0.585}

# ---------------------------------------------------------------------------
# Projection ETRS89-LAEA (EPSG:3035), celle des carreaux INSEE.
# Paramètres officiels : origine 52°N 10°E, ellipsoïde GRS80.
# ---------------------------------------------------------------------------
A = 6378137.0                 # demi-grand axe GRS80
F = 1 / 298.257222101         # aplatissement
E2 = F * (2 - F)
E = math.sqrt(E2)
LAT0, LON0 = math.radians(52.0), math.radians(10.0)
FAUX_EST, FAUX_NORD = 4321000.0, 3210000.0


def _q(sinphi):
    """Fonction d'aire authalique de Snyder."""
    return (1 - E2) * (sinphi / (1 - E2 * sinphi ** 2)
                       - (1 / (2 * E)) * math.log((1 - E * sinphi) / (1 + E * sinphi)))


_QP = _q(math.sin(math.pi / 2))
_RQ = A * math.sqrt(_QP / 2)


def _beta(phi):
    return math.asin(_q(math.sin(phi)) / _QP)


_BETA0 = _beta(LAT0)
_D = A * (math.cos(LAT0) / math.sqrt(1 - E2 * math.sin(LAT0) ** 2)) / (
    _RQ * math.cos(_BETA0))


def laea_vers_wgs84(x, y):
    """Convertit des coordonnées EPSG:3035 en (latitude, longitude) degrés."""
    xp = (x - FAUX_EST) / _D
    yp = (y - FAUX_NORD) * _D
    rho = math.hypot(xp, yp)
    if rho < 1e-9:
        return math.degrees(LAT0), math.degrees(LON0)
    ce = 2 * math.asin(rho / (2 * _RQ))
    cos_ce, sin_ce = math.cos(ce), math.sin(ce)
    beta = math.asin(cos_ce * math.sin(_BETA0) + (yp * sin_ce * math.cos(_BETA0) / rho))
    lam = LON0 + math.atan2(xp * sin_ce,
                            rho * math.cos(_BETA0) * cos_ce - yp * math.sin(_BETA0) * sin_ce)
    # Retour de la latitude authalique vers la latitude géodésique (série).
    phi = beta + ((E2 / 3 + 31 * E2 ** 2 / 180 + 517 * E2 ** 3 / 5040) * math.sin(2 * beta)
                  + (23 * E2 ** 2 / 360 + 251 * E2 ** 3 / 3780) * math.sin(4 * beta)
                  + (761 * E2 ** 3 / 45360) * math.sin(6 * beta))
    return math.degrees(phi), math.degrees(lam)


def wgs84_vers_laea(lat, lon):
    """Sens direct — sert uniquement à l'autotest de la projection."""
    phi, lam = math.radians(lat), math.radians(lon)
    beta, dlam = _beta(phi), lam - LON0
    b = _RQ * math.sqrt(2 / (1 + math.sin(_BETA0) * math.sin(beta)
                             + math.cos(_BETA0) * math.cos(beta) * math.cos(dlam)))
    x = FAUX_EST + b * _D * math.cos(beta) * math.sin(dlam)
    y = FAUX_NORD + (b / _D) * (math.cos(_BETA0) * math.sin(beta)
                                - math.sin(_BETA0) * math.cos(beta) * math.cos(dlam))
    return x, y


def autotest():
    """Vérifie la projection avant d'importer quoi que ce soit."""
    cas = [(52.0, 10.0, "origine"), (44.806, -0.631, "Pessac"), (48.8566, 2.3522, "Paris")]
    ok = True
    for lat, lon, nom in cas:
        x, y = wgs84_vers_laea(lat, lon)
        rlat, rlon = laea_vers_wgs84(x, y)
        err = math.hypot((rlat - lat) * 111320, (rlon - lon) * 111320 * math.cos(math.radians(lat)))
        etat = "OK" if err < 0.5 else "ÉCHEC"
        if err >= 0.5:
            ok = False
        print(f"  {etat:<6} {nom:<10} E={x:>10.0f} N={y:>10.0f}  aller-retour {err:.3f} m")
    # L'origine doit tomber exactement sur le faux est/nord.
    x0, y0 = wgs84_vers_laea(52.0, 10.0)
    if abs(x0 - FAUX_EST) > 0.5 or abs(y0 - FAUX_NORD) > 0.5:
        print(f"  ÉCHEC  origine mal placée : {x0:.1f}, {y0:.1f}")
        ok = False
    return ok


# ---------------------------------------------------------------------------
# Lecture du fichier INSEE
# ---------------------------------------------------------------------------
MOTIF_ID = re.compile(r"N(\d+)E(\d+)")

# L'INSEE renomme ses colonnes d'un millésime à l'autre : on accepte les variantes.
COLONNES = {
    "id":        ["idcar_200m", "idcar200m", "idINSPIRE", "idcar_1km"],
    "individus": ["ind", "ind_c", "Ind"],
    "menages":   ["men", "men_c", "Men"],
    "men_1ind":  ["men_1ind", "men_1ind_c"],
    "men_pauv":  ["men_pauv", "men_pauv_c"],
    "log_soc":   ["log_soc", "log_soc_c", "men_prop"],
    "surface":   ["log_surf", "men_surf"],
}


def reperer(entetes):
    trouve = {}
    bas = {h.lower().strip(): h for h in entetes}
    for cle, variantes in COLONNES.items():
        for v in variantes:
            if v.lower() in bas:
                trouve[cle] = bas[v.lower()]
                break
    return trouve


def nombre(v):
    if v is None or v == "":
        return 0.0
    try:
        return float(str(v).replace(",", "."))
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fichier", nargs="?", help="CSV des carreaux INSEE")
    ap.add_argument("--autotest", action="store_true", help="vérifier la projection puis sortir")
    args = ap.parse_args()

    print("Autotest de la projection LAEA :")
    if not autotest():
        sys.exit("\n❌ La conversion de coordonnées est fausse — import interrompu.")
    print("✅ Projection valide.\n")
    if args.autotest:
        return
    if not args.fichier:
        sys.exit("Indiquez le fichier CSV INSEE. Voir DONNEES_INSEE.md.")

    src = Path(args.fichier)
    if not src.exists():
        sys.exit(f"❌ Fichier introuvable : {src}")

    # L'INSEE publie tantôt en ';' tantôt en ',' : on laisse csv le déterminer.
    with src.open(encoding="utf-8-sig", newline="") as f:
        debut = f.read(8192)
        f.seek(0)
        try:
            dialecte = csv.Sniffer().sniff(debut, delimiters=";,\t")
        except csv.Error:
            dialecte = csv.excel
            dialecte.delimiter = ";"
        lecteur = csv.DictReader(f, dialect=dialecte)
        cols = reperer(lecteur.fieldnames or [])
        if "id" not in cols or "individus" not in cols:
            sys.exit("❌ Colonnes attendues introuvables. Colonnes présentes :\n   "
                     + ", ".join(lecteur.fieldnames or []))
        print(f"Colonnes reconnues : {cols}\n")

        carreaux, lus, hors = [], 0, 0
        for ligne in lecteur:
            lus += 1
            m = MOTIF_ID.search(ligne[cols["id"]] or "")
            if not m:
                continue
            # L'identifiant porte le coin SUD-OUEST du carreau : on vise le centre.
            n, e = int(m.group(1)) + 100, int(m.group(2)) + 100
            lat, lon = laea_vers_wgs84(e, n)
            if not (EMPRISE["sud"] <= lat <= EMPRISE["nord"]
                    and EMPRISE["ouest"] <= lon <= EMPRISE["est"]):
                hors += 1
                continue
            ind = nombre(ligne.get(cols.get("individus")))
            if ind <= 0:
                continue
            c = {"lat": round(lat, 6), "lon": round(lon, 6), "ind": round(ind, 1)}
            for cle in ("menages", "men_1ind", "men_pauv", "log_soc"):
                col = cols.get(cle)
                if col:
                    c[cle] = round(nombre(ligne.get(col)), 1)
            carreaux.append(c)

    if not carreaux:
        sys.exit(f"❌ Aucun carreau dans l'emprise ({lus} lignes lues, {hors} hors zone). "
                 "Vérifiez que le fichier couvre bien la Gironde.")

    total = sum(c["ind"] for c in carreaux)
    SORTIE.write_text(json.dumps({
        "meta": {
            "ville": "Pessac", "source": f"INSEE Filosofi carroyé 200 m — {src.name}",
            "maille_m": 200, "nb_carreaux": len(carreaux),
            "population_totale": round(total),
            "note": "Population réellement observée, maille par maille. Remplace les "
                    "estimations par quartier qui limitaient la fiabilité du modèle.",
        },
        "carreaux": carreaux,
    }, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"✅ {len(carreaux)} carreaux retenus — {round(total):,} habitants".replace(",", " "))
    print(f"   {lus} lignes lues, {hors} hors emprise")
    print(f"   → {SORTIE}")
    print("\n   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
