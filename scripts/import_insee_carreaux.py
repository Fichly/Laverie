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
import itertools
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


# ---------------------------------------------------------------------------
# Lambert 93 (EPSG:2154) — l'autre projection utilisée par l'INSEE selon les
# millésimes et les formats. Conique conforme sécante, ellipsoïde GRS80.
# ---------------------------------------------------------------------------
L93_LON0, L93_LAT0 = math.radians(3.0), math.radians(46.5)
L93_LAT1, L93_LAT2 = math.radians(44.0), math.radians(49.0)
L93_X0, L93_Y0 = 700000.0, 6600000.0


def _m(phi):
    return math.cos(phi) / math.sqrt(1 - E2 * math.sin(phi) ** 2)


def _t(phi):
    return (math.tan(math.pi / 4 - phi / 2)
            / ((1 - E * math.sin(phi)) / (1 + E * math.sin(phi))) ** (E / 2))


_L93_N = (math.log(_m(L93_LAT1) / _m(L93_LAT2))
          / math.log(_t(L93_LAT1) / _t(L93_LAT2)))
_L93_F = _m(L93_LAT1) / (_L93_N * _t(L93_LAT1) ** _L93_N)
_L93_RHO0 = A * _L93_F * _t(L93_LAT0) ** _L93_N


def wgs84_vers_l93(lat, lon):
    phi, lam = math.radians(lat), math.radians(lon)
    rho = A * _L93_F * _t(phi) ** _L93_N
    theta = _L93_N * (lam - L93_LON0)
    return L93_X0 + rho * math.sin(theta), L93_Y0 + _L93_RHO0 - rho * math.cos(theta)


def emprise_dans(projection):
    """Emprise de la ville pilote dans la projection demandée."""
    coins = [(EMPRISE["sud"], EMPRISE["ouest"]), (EMPRISE["sud"], EMPRISE["est"]),
             (EMPRISE["nord"], EMPRISE["ouest"]), (EMPRISE["nord"], EMPRISE["est"])]
    if projection == 4326:
        xs, ys = [c[1] for c in coins], [c[0] for c in coins]
        return min(xs) - 0.005, max(xs) + 0.005, min(ys) - 0.005, max(ys) + 0.005
    conv = wgs84_vers_l93 if projection == 2154 else wgs84_vers_laea
    xy = [conv(a, b) for a, b in coins]
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    return min(xs) - 200, max(xs) + 200, min(ys) - 200, max(ys) + 200


def deviner_projection(xmin, xmax, ymin, ymax):
    """Déduit la projection des ordres de grandeur observés dans l'index spatial.

    Le srs_id déclaré dans le GeoPackage n'est pas toujours celui des données :
    on croise donc la déclaration avec ce qu'on mesure réellement.
    """
    if -180 <= xmin <= 180 and -90 <= ymin <= 90:
        return 4326
    if 5_000_000 < ymin < 8_000_000:      # Lambert 93 : Y autour de 6-7 millions
        return 2154
    if 1_000_000 < ymin < 4_000_000:      # LAEA : N autour de 2-3 millions
        return 3035
    return None


def emprise_laea():
    """Emprise de la ville pilote convertie en EPSG:3035, pour filtrer côté SQL."""
    coins = [(EMPRISE["sud"], EMPRISE["ouest"]), (EMPRISE["sud"], EMPRISE["est"]),
             (EMPRISE["nord"], EMPRISE["ouest"]), (EMPRISE["nord"], EMPRISE["est"])]
    xy = [wgs84_vers_laea(a, b) for a, b in coins]
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    # Marge d'un carreau pour ne rien perdre au bord.
    return min(xs) - 200, max(xs) + 200, min(ys) - 200, max(ys) + 200


def lire_gpkg(src):
    """Lit un GeoPackage INSEE.

    Un .gpkg est une base SQLite : le module standard suffit, pas besoin de GDAL
    ni de geopandas. On filtre directement en SQL sur l'index spatial R-tree
    quand il existe, ce qui évite de parcourir le fichier entier (1,1 Go pour la
    France métropolitaine).
    """
    import sqlite3
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    table = cur.execute(
        "SELECT table_name FROM gpkg_contents ORDER BY table_name LIMIT 1").fetchone()
    if not table:
        raise SystemExit("❌ Aucune table de données dans ce GeoPackage.")
    table = table["table_name"]
    colonnes = [r["name"] for r in cur.execute(f'PRAGMA table_info("{table}")')]
    print(f"Table « {table} » — {len(colonnes)} colonnes")

    # Le srs_id déclaré ne suffit pas : selon le millésime et l'outil de
    # publication, la géométrie peut être en LAEA, en Lambert 93 ou en degrés.
    # On mesure donc l'étendue réelle de l'index avant de filtrer.
    srs = cur.execute("SELECT srs_id FROM gpkg_contents WHERE table_name=?",
                      (table,)).fetchone()
    srs = srs["srs_id"] if srs else None

    rtree = None
    for nom in [f"rtree_{table}_geom", f"rtree_{table}_geometry", f"rtree_{table}_the_geom"]:
        if cur.execute("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') "
                       "AND name=?", (nom,)).fetchone():
            rtree = nom
            break

    lignes = None
    if rtree:
        etendue = cur.execute(
            f'SELECT MIN(minx) a, MAX(maxx) b, MIN(miny) c, MAX(maxy) d FROM "{rtree}"'
        ).fetchone()
        mesure = deviner_projection(etendue["a"], etendue["b"], etendue["c"], etendue["d"])
        print(f"Index spatial : {rtree}")
        print(f"  étendue X {etendue['a']:.0f} → {etendue['b']:.0f} · "
              f"Y {etendue['c']:.0f} → {etendue['d']:.0f}")
        print(f"  srs_id déclaré : {srs} · projection retenue : {mesure or 'indéterminée'}")

        if mesure:
            xmin, xmax, ymin, ymax = emprise_dans(mesure)
            req = (f'SELECT t.*, r.minx AS _minx, r.miny AS _miny, r.maxx AS _maxx, '
                   f'r.maxy AS _maxy FROM "{table}" t JOIN "{rtree}" r ON t.rowid = r.id '
                   f"WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?")
            # On lit une première ligne pour savoir si le filtre donne quelque
            # chose, puis on POURSUIT le même curseur — le ré-exécuter
            # renverrait la première ligne une seconde fois.
            curseur = cur.execute(req, (xmin, xmax, ymin, ymax))
            premiere = curseur.fetchmany(1)
            if premiere:
                lignes = itertools.chain(premiere, curseur)
                # _minx/_maxx ne servent de repli que si la géométrie est en LAEA :
                # dans les autres projections, seul l'identifiant fait foi.
                if mesure != 3035:
                    lignes = ({k: v for k, v in dict(r).items()
                               if not k.startswith("_")} for r in lignes)
            else:
                print("  ⚠ Le filtrage spatial ne renvoie rien : bascule en lecture "
                      "complète (la projection déduite était probablement fausse).")

    if lignes is None:
        print("Projection non reconnue : lecture complète, positionnement par "
              "l'identifiant de carreau (comptez une à deux minutes).")
        lignes = cur.execute(f'SELECT * FROM "{table}"')

    for r in lignes:
        yield dict(r)
    con.close()


def lire_parquet(src):
    """Lit un Parquet INSEE. Nécessite pyarrow (pip install pyarrow)."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        raise SystemExit(
            "❌ Le format Parquet demande pyarrow :\n"
            "     pip install pyarrow\n"
            "   Ou utilisez plutôt le GeoPackage (.gpkg), lu sans aucune dépendance.")
    fichier = pq.ParquetFile(src)
    for lot in fichier.iter_batches(batch_size=50000):
        for ligne in lot.to_pylist():
            yield ligne


def lire_csv(src):
    with src.open(encoding="utf-8-sig", newline="") as f:
        debut = f.read(8192)
        f.seek(0)
        try:
            dialecte = csv.Sniffer().sniff(debut, delimiters=";,\t")
        except csv.Error:
            dialecte = csv.excel
            dialecte.delimiter = ";"
        for ligne in csv.DictReader(f, dialect=dialecte):
            yield ligne


def lire_source(src):
    ext = src.suffix.lower()
    if ext == ".gpkg":
        return lire_gpkg(src)
    if ext == ".parquet":
        return lire_parquet(src)
    if ext in (".csv", ".txt"):
        return lire_csv(src)
    raise SystemExit(f"❌ Format non géré : {ext}. Attendu : .gpkg, .parquet ou .csv")


def nombre(v):
    if v is None or v == "":
        return 0.0
    try:
        return float(str(v).replace(",", "."))
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fichier", nargs="?", help="fichier INSEE (.gpkg, .parquet ou .csv)")
    ap.add_argument("--autotest", action="store_true", help="vérifier la projection puis sortir")
    args = ap.parse_args()

    print("Autotest de la projection LAEA :")
    if not autotest():
        sys.exit("\n❌ La conversion de coordonnées est fausse — import interrompu.")
    print("✅ Projection valide.\n")
    if args.autotest:
        return
    if not args.fichier:
        sys.exit("Indiquez le fichier INSEE (.gpkg, .parquet ou .csv). Voir DONNEES_INSEE.md.")

    src = Path(args.fichier)
    if not src.exists():
        sys.exit(f"❌ Fichier introuvable : {src}")
    print(f"Lecture de {src.name} ({src.stat().st_size / 1e6:.0f} Mo)\n")

    carreaux, lus, hors, cols = [], 0, 0, None
    for ligne in lire_source(src):
        lus += 1
        if cols is None:
            cols = reperer(list(ligne.keys()))
            print(f"Colonnes reconnues : {cols or 'AUCUNE'}")
            if "individus" not in cols:
                sys.exit("❌ Colonne de population introuvable. Colonnes présentes :\n   "
                         + ", ".join(list(ligne.keys())[:40]))

        # Position : par l'identifiant de carreau si présent, sinon par l'emprise
        # fournie par l'index spatial du GeoPackage.
        lat = lon = None
        if cols.get("id"):
            m = MOTIF_ID.search(str(ligne.get(cols["id"]) or ""))
            if m:
                # L'identifiant porte le coin SUD-OUEST : on vise le centre du carreau.
                lat, lon = laea_vers_wgs84(int(m.group(2)) + 100, int(m.group(1)) + 100)
        if lat is None and ligne.get("_minx") is not None:
            lat, lon = laea_vers_wgs84((ligne["_minx"] + ligne["_maxx"]) / 2,
                                       (ligne["_miny"] + ligne["_maxy"]) / 2)
        if lat is None:
            continue

        if not (EMPRISE["sud"] <= lat <= EMPRISE["nord"]
                and EMPRISE["ouest"] <= lon <= EMPRISE["est"]):
            hors += 1
            continue
        ind = nombre(ligne.get(cols["individus"]))
        if ind <= 0:
            continue
        c = {"lat": round(lat, 6), "lon": round(lon, 6), "ind": round(ind, 1)}
        for cle in ("menages", "men_1ind", "men_pauv", "log_soc"):
            col = cols.get(cle)
            if col is not None and ligne.get(col) is not None:
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

    print(f"\n✅ {len(carreaux)} carreaux retenus — "
          + f"{round(total):,} habitants".replace(",", " "))
    print(f"   {lus} lignes lues, {hors} hors emprise")
    print(f"   → {SORTIE}")
    print("\n   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
