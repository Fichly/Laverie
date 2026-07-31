#!/usr/bin/env python3
"""Récupère les entreprises de laverie (SIRENE) et leurs comptes annuels publiés.

POURQUOI CE SCRIPT EST LE PLUS IMPORTANT DU PROJET

Jusqu'ici le modèle prédit un chiffre d'affaires sans jamais en observer un
seul : il est calé sur une hypothèse (« une laverie de Pessac fait 50 000 € »)
que personne n'a mesurée. Tous les euros affichés sont donc une convention.

Ce script va chercher les chiffres réels là où ils sont publics :

  SIRENE      immatriculations, dates de création, état administratif,
              tranche d'effectif — pour chaque établissement de laverie.
  Comptes     chiffre d'affaires et résultat net des sociétés qui déposent
  annuels     leurs comptes au greffe (SARL, SAS…).

Source : API Recherche d'entreprises (annuaire-entreprises.data.gouv.fr),
gratuite, sans clé, sans inscription.

    python3 scripts/import_entreprises.py                     # périmètre par défaut
    python3 scripts/import_entreprises.py --communes 33600,33400
    python3 scripts/import_entreprises.py --diagnostic        # dump d'un enregistrement brut

CE QUE CE SCRIPT NE PROMET PAS

1. Toutes les sociétés ne déposent pas leurs comptes, et depuis 2016 les petites
   entreprises peuvent demander la confidentialité de leur compte de résultat.
   Comptez une couverture partielle : c'est normal, ce n'est pas un bug.
2. Le chiffre d'affaires est celui de l'UNITÉ LÉGALE, pas de l'établissement.
   Une société qui exploite trois laveries publie un CA cumulé, inexploitable
   pour caler une seule adresse. Le script marque donc chaque ligne d'un
   `ca_attribuable` : faux dès que la société a plus d'un établissement ouvert.
   Ne calez jamais le modèle sur une ligne non attribuable.
3. Les entreprises individuelles et micro-entrepreneurs ne publient rien.
"""

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
LAVERIES = RACINE / "data" / "laveries.json"
SORTIE = RACINE / "data" / "entreprises.json"

API = "https://recherche-entreprises.api.gouv.fr/search"

# 96.01B « Blanchisserie-teinturerie de détail » : c'est le code des laveries
# libre-service — et aussi des pressings, qu'on distinguera ensuite par le nom.
NAF_DEFAUT = "96.01B"

# Même emprise que le carroyage INSEE et que la recherche de concurrents :
# la validation doit porter sur toutes les laveries que le modèle voit.
COMMUNES_DEFAUT = [
    "33600",  # Pessac
    "33400",  # Talence
    "33700",  # Mérignac
    "33170",  # Gradignan
    "33000", "33100", "33200", "33300", "33800",  # Bordeaux
    "33130",  # Bègles
    "33270",  # Floirac
    "33110",  # Le Bouscat
]

# Un pressing est un dépôt avec personnel : autre métier, autres coûts, autre
# chiffre d'affaires. Le garder fausserait le calage.
MOTS_PRESSING = ("pressing", "nettoyage a sec", "teinturerie", "retouche")
MOTS_LAVERIE = ("laverie", "lavomatic", "laverie automatique", "wash", "lav",
                "libre service", "libre-service")

# Codes de tranche d'effectif SIRENE → fourchette lisible.
EFFECTIFS = {
    "NN": None, "00": (0, 0), "01": (1, 2), "02": (3, 5), "03": (6, 9),
    "11": (10, 19), "12": (20, 49), "21": (50, 99), "22": (100, 199),
    "31": (200, 249), "32": (250, 499), "41": (500, 999), "42": (1000, 1999),
    "51": (2000, 4999), "52": (5000, 9999), "53": (10000, None),
}


# ---------------------------------------------------------------- utilitaires

def normaliser(texte):
    """Minuscules sans accents ni ponctuation, pour comparer des noms."""
    if not texte:
        return ""
    t = unicodedata.normalize("NFD", str(texte))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9 ]+", " ", t).strip()


def distance_m(lat1, lon1, lat2, lon2):
    from math import asin, cos, radians, sin, sqrt
    r = 6371000
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(a))


def parcourir(obj):
    """Parcourt récursivement dictionnaires et listes, en yieldant chaque dict."""
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from parcourir(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from parcourir(v)


def premiere_valeur(obj, *cles):
    """Première valeur non vide trouvée pour l'une de ces clés, à n'importe
    quelle profondeur.

    L'API peut faire évoluer son imbrication ; chercher la clé plutôt que le
    chemin évite que le script casse silencieusement à la prochaine version.
    """
    for d in parcourir(obj):
        for c in cles:
            v = d.get(c)
            if v not in (None, "", [], {}):
                return v
    return None


def nombre(v):
    if v in (None, "", "NN"):
        return None
    try:
        return float(str(v).replace(" ", "").replace(",", "."))
    except ValueError:
        return None


# ------------------------------------------------------------------ requêtes

def appeler(params, essais=3):
    url = API + "?" + urllib.parse.urlencode(params)
    for n in range(essais):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:                      # quota : on laisse retomber
                time.sleep(2 * (n + 1))
                continue
            print(f"  ⚠ HTTP {e.code} sur {url[:110]}", file=sys.stderr)
            return None
        except (urllib.error.URLError, TimeoutError) as e:
            if n == essais - 1:
                print(f"  ⚠ réseau : {e}", file=sys.stderr)
                return None
            time.sleep(2 * (n + 1))
    return None


def chercher(params_base):
    """Pagine jusqu'à épuisement et renvoie la liste brute des résultats."""
    tout, page = [], 1
    while True:
        params = dict(params_base, page=page, per_page=25)
        rep = appeler(params)
        if not rep:
            break
        resultats = rep.get("results") or rep.get("resultats") or []
        tout.extend(resultats)
        total_pages = rep.get("total_pages") or 1
        if page >= total_pages or not resultats:
            break
        page += 1
        time.sleep(0.2)                            # l'API tolère ~7 req/s
    return tout


# ------------------------------------------------------------ normalisation

def finances_de(unite):
    """Extrait les comptes annuels, quelle que soit la forme retenue par l'API.

    Deux formes ont été observées selon les versions : un dictionnaire indexé
    par année ({"2022": {...}}), ou une liste d'objets portant l'année.
    """
    brut = premiere_valeur(unite, "finances")
    lignes = []
    if isinstance(brut, dict):
        for annee, v in brut.items():
            if isinstance(v, dict):
                lignes.append((annee, v))
    elif isinstance(brut, list):
        for v in brut:
            if isinstance(v, dict):
                lignes.append((v.get("annee") or v.get("annee_finances"), v))

    sortie = []
    for annee, v in lignes:
        ca = nombre(v.get("ca") or v.get("chiffre_affaires")
                    or v.get("chiffre_affaires_ht"))
        res = nombre(v.get("resultat_net") or v.get("resultat")
                     or v.get("resultat_exercice"))
        a = nombre(annee)
        if a and (ca is not None or res is not None):
            sortie.append({"annee": int(a), "ca": ca, "resultat_net": res})
    return sorted(sortie, key=lambda x: -x["annee"])


def etablissements_de(unite):
    """Renvoie les établissements portant un SIRET, siège compris."""
    vus, sortie = set(), []
    candidats = []
    for cle in ("matching_etablissements", "etablissements"):
        v = premiere_valeur(unite, cle)
        if isinstance(v, list):
            candidats.extend(v)
    siege = premiere_valeur(unite, "siege")
    if isinstance(siege, dict):
        candidats.append(siege)

    for e in candidats:
        if not isinstance(e, dict):
            continue
        siret = e.get("siret")
        if not siret or siret in vus:
            continue
        vus.add(siret)
        sortie.append(e)
    return sortie


def est_une_laverie(nom, activite):
    """Écarte les pressings, qui partagent le code NAF mais pas le métier."""
    t = normaliser(nom) + " " + normaliser(activite)
    if any(m in t for m in MOTS_LAVERIE):
        return True
    if any(m in t for m in MOTS_PRESSING):
        return False
    return True          # dans le doute on garde : le rapport le signalera


def convertir(unite):
    """Transforme une unité légale de l'API en une ou plusieurs lignes propres."""
    siren = premiere_valeur(unite, "siren")
    nom = (premiere_valeur(unite, "nom_complet", "nom_raison_sociale",
                           "denomination") or "").strip()
    activite = premiere_valeur(unite, "libelle_activite_principale",
                               "activite_principale") or ""
    fin = finances_de(unite)

    ouverts = nombre(premiere_valeur(unite, "nombre_etablissements_ouverts"))
    etabs = etablissements_de(unite)
    if ouverts is None:
        ouverts = sum(1 for e in etabs if (e.get("etat_administratif") or "A") == "A")

    tranche = premiere_valeur(unite, "tranche_effectif_salarie")
    effectif = EFFECTIFS.get(str(tranche)) if tranche else None

    lignes = []
    for e in etabs:
        lat, lon = nombre(e.get("latitude")), nombre(e.get("longitude"))
        etat = e.get("etat_administratif") or "A"
        nom_etab = (e.get("nom_commercial") or e.get("enseigne_1")
                    or e.get("liste_enseignes") or nom)
        if isinstance(nom_etab, list):
            nom_etab = nom_etab[0] if nom_etab else nom
        lignes.append({
            "siren": siren,
            "siret": e.get("siret"),
            "nom": nom,
            "enseigne": nom_etab if nom_etab != nom else None,
            "activite": activite,
            "adresse": e.get("adresse"),
            "code_postal": e.get("code_postal"),
            "commune": e.get("libelle_commune"),
            "lat": lat, "lon": lon,
            "date_creation": (e.get("date_creation")
                              or premiere_valeur(unite, "date_creation")),
            "date_fermeture": e.get("date_fermeture"),
            "actif": etat == "A",
            "effectif_min": effectif[0] if effectif else None,
            "effectif_max": effectif[1] if effectif else None,
            "nb_etablissements_ouverts": int(ouverts or 0),
            # Le CA est publié au niveau société : il n'est imputable à CETTE
            # adresse que si la société n'exploite qu'un seul établissement.
            "ca_attribuable": bool(fin) and int(ouverts or 0) <= 1,
            "finances": fin,
            "source": "API Recherche d'entreprises (SIRENE + comptes annuels)",
            "est_laverie": est_une_laverie(nom_etab or nom, activite),
        })
    return lignes


# ------------------------------------------------------ rapprochement laveries

def rapprocher(lignes, laveries):
    """Associe chaque établissement à une laverie de l'inventaire.

    Deux critères, dans cet ordre : la proximité géographique (une adresse à
    moins de 120 m, c'est la même boutique), puis la ressemblance des noms.
    """
    for l in lignes:
        l["laverie_id"] = None
        l["rapprochement"] = None
        meilleur, meilleure_d = None, 1e9
        if l["lat"] and l["lon"]:
            for lav in laveries:
                d = distance_m(l["lat"], l["lon"], lav["lat"], lav["lon"])
                if d < meilleure_d:
                    meilleur, meilleure_d = lav, d
        if meilleur and meilleure_d <= 120:
            l["laverie_id"] = meilleur["id"]
            l["rapprochement"] = f"position ({meilleure_d:.0f} m)"
            continue

        mots = set(normaliser(l["enseigne"] or l["nom"]).split()) - {
            "laverie", "sarl", "sas", "eurl", "sasu", "automatique", "de", "la", "le"}
        for lav in laveries:
            mots_lav = set(normaliser(lav["nom"]).split())
            communs = mots & mots_lav
            if communs and (not l["lat"] or meilleure_d <= 600):
                l["laverie_id"] = lav["id"]
                l["rapprochement"] = "nom (" + ", ".join(sorted(communs)) + ")"
                break
    return lignes


# ------------------------------------------------------------------- rapport

def resume(lignes):
    lav = [l for l in lignes if l["est_laverie"]]
    actifs = [l for l in lav if l["actif"]]
    avec_ca = [l for l in lav if l["ca_attribuable"]]
    cas = sorted(l["finances"][0]["ca"] for l in avec_ca if l["finances"][0]["ca"])
    mediane = cas[len(cas) // 2] if cas else None
    return {
        "etablissements": len(lav),
        "actifs": len(actifs),
        "fermes": len(lav) - len(actifs),
        "avec_comptes_publies": sum(1 for l in lav if l["finances"]),
        "avec_ca_attribuable": len(avec_ca),
        "ca_median_attribuable": mediane,
        "rapproches_inventaire": sum(1 for l in lav if l["laverie_id"]),
        "pressings_ecartes": sum(1 for l in lignes if not l["est_laverie"]),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--communes", help="codes postaux séparés par des virgules")
    ap.add_argument("--naf", default=NAF_DEFAUT, help=f"code NAF (défaut {NAF_DEFAUT})")
    ap.add_argument("--diagnostic", action="store_true",
                    help="affiche un enregistrement brut et s'arrête")
    args = ap.parse_args()

    codes = ([c.strip() for c in args.communes.split(",")] if args.communes
             else COMMUNES_DEFAUT)

    if args.diagnostic:
        rep = appeler({"code_naf": args.naf, "code_postal": codes[0], "per_page": 1})
        print(json.dumps(rep, ensure_ascii=False, indent=2)[:6000])
        print("\n(envoyez ce bloc si le script ne trouve rien : il dit la forme "
              "exacte des réponses de l'API)")
        return

    print(f"Recherche NAF {args.naf} sur {len(codes)} codes postaux…\n")
    unites, vus = [], set()
    for cp in codes:
        # Deux passes : par code NAF (précis), puis en texte libre (rattrape les
        # laveries mal codées, il y en a toujours).
        for params in ({"code_naf": args.naf, "code_postal": cp},
                       {"q": "laverie automatique", "code_postal": cp}):
            for u in chercher(params):
                s = premiere_valeur(u, "siren")
                if s and s not in vus:
                    vus.add(s)
                    unites.append(u)
        print(f"  {cp} : {len(vus)} sociétés cumulées")

    if not unites:
        sys.exit("\n❌ Aucune société trouvée. Vérifiez votre connexion, puis "
                 "relancez avec --diagnostic pour voir la réponse brute de l'API.")

    lignes = []
    for u in unites:
        lignes.extend(convertir(u))

    laveries = json.loads(LAVERIES.read_text(encoding="utf-8"))["laveries"]
    rapprocher(lignes, laveries)
    r = resume(lignes)

    SORTIE.write_text(json.dumps({
        "meta": {
            "source": "API Recherche d'entreprises — SIRENE + comptes annuels des greffes",
            "naf": args.naf,
            "codes_postaux": codes,
            "avertissement": (
                "Le chiffre d'affaires est publié au niveau de la société, pas de "
                "l'établissement. Il n'est imputable à une adresse que si "
                "ca_attribuable vaut true. Toutes les sociétés ne déposent pas "
                "leurs comptes : la couverture est partielle par construction."),
            **r,
        },
        "etablissements": lignes,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n✅ {r['etablissements']} établissements de laverie "
          f"({r['actifs']} actifs, {r['fermes']} fermés)")
    print(f"   {r['avec_comptes_publies']} avec comptes publiés, dont "
          f"{r['avec_ca_attribuable']} imputables à une seule adresse")
    if r["ca_median_attribuable"]:
        print(f"   CA médian observé : {r['ca_median_attribuable']:,.0f} €"
              .replace(",", " "))
        print("   → c'est ce chiffre qui doit remplacer l'hypothèse de 50 000 €")
    else:
        print("   ⚠ aucun CA imputable : le calage reste sur les repères du secteur")
    print(f"   {r['rapproches_inventaire']} rapprochés de l'inventaire, "
          f"{r['pressings_ecartes']} pressings écartés")
    print(f"   → {SORTIE}")
    print("\n   Étape suivante : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
