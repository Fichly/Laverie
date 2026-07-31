#!/usr/bin/env python3
"""Récupère l'historique BODACC des laveries : radiations, cessions, dépôts.

CE QUE BODACC APPORTE ET QUE SIRENE N'A PAS

SIRENE décrit le présent : qui est ouvert aujourd'hui. BODACC décrit les
mouvements, et c'est ce qui manque le plus à une décision d'implantation :

  radiations   qui a fermé, et quand. Un quartier où trois laveries ont fermé
               en cinq ans n'est pas une opportunité, c'est un avertissement.
  ventes et    les cessions de fonds de commerce sont publiées AVEC LEUR PRIX.
  cessions     C'est la seule source publique qui dise ce que vaut réellement
               une laverie en Gironde — donc ce que vous devriez payer.
  dépôts de    dit quelles sociétés ont déposé leurs comptes, donc où le
  comptes      chiffre d'affaires est allé chercher.

Source : API BODACC de la DILA, gratuite, sans clé.

    python3 scripts/import_entreprises.py      # d'abord : fournit les SIREN
    python3 scripts/import_bodacc.py           # ensuite : leur historique
    python3 scripts/import_bodacc.py --diagnostic

Le script interroge d'abord les SIREN connus, puis balaie le département à la
recherche de cessions de laveries dont nous ignorons l'existence — celles-là
donnent des prix de transaction même sans être dans l'inventaire.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
ENTREPRISES = RACINE / "data" / "entreprises.json"
SORTIE = RACINE / "data" / "bodacc.json"

API = ("https://bodacc-datadila.opendatasoft.com/api/explore/v2.1"
       "/catalog/datasets/annonces-commerciales/records")
DEPARTEMENT = "33"

# Plusieurs formulations d'une même recherche : l'API a changé de syntaxe entre
# ses versions, on essaie dans l'ordre et on retient celle qui répond.
STRATEGIES = [
    lambda siren: f'registre like "{siren}"',
    lambda siren: f'"{siren}"',
    lambda siren: f'search(registre, "{siren}")',
]

# Un prix de cession dans le texte : « moyennant le prix de 85 000 € ».
MOTIF_PRIX = re.compile(
    r"(?:prix|moyennant|cession)[^.\d]{0,60}?([\d][\d\s.,]{2,15})\s*(?:€|EUR|euros)",
    re.IGNORECASE)

MOTS_LAVERIE = ("laverie", "lavomatic", "laverie automatique", "libre service",
                "libre-service", "blanchisserie")


def joignable():
    """Un appel court pour vérifier que l'API BODACC répond avant de boucler."""
    try:
        req = urllib.request.Request(API + "?limit=1",
                                     headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=12):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:                   # noqa: BLE001
        return False


def appeler(params, essais=2):
    url = API + "?" + urllib.parse.urlencode(params)
    for n in range(essais):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(3 * (n + 1))
                continue
            if e.code == 400:               # syntaxe refusée : stratégie suivante
                return None
            print(f"  ⚠ HTTP {e.code}", file=sys.stderr)
            return None
        except (urllib.error.URLError, TimeoutError):
            if n == essais - 1:
                return None
            time.sleep(2 * (n + 1))
    return None


def interroger(where, limite=100, pages=5):
    """Pagine une requête ODSQL. Renvoie None si la syntaxe est refusée."""
    tout, offset, premiere = [], 0, True
    while offset < limite * pages:
        rep = appeler({"where": where, "limit": limite, "offset": offset,
                       "order_by": "dateparution desc"})
        if rep is None:
            return None if premiere else tout
        premiere = False
        res = rep.get("results") or []
        tout.extend(res)
        if len(res) < limite:
            break
        offset += limite
        time.sleep(0.25)
    return tout


def texte_de(enregistrement):
    """Toute l'annonce à plat : les champs utiles changent selon le type d'avis,
    chercher dans le texte complet est plus fiable que de viser un champ."""
    return json.dumps(enregistrement, ensure_ascii=False)


def prix_de(enregistrement):
    m = MOTIF_PRIX.search(texte_de(enregistrement).replace("\\u20ac", "€"))
    if not m:
        return None
    brut = m.group(1).replace(" ", "").replace(" ", "").replace("\xa0", "")
    # 85.000,50 → 85000.50 ; 85 000 → 85000
    if "," in brut:
        brut = brut.replace(".", "").replace(",", ".")
    else:
        brut = brut.replace(".", "")
    try:
        v = float(brut)
    except ValueError:
        return None
    return v if 1000 <= v <= 3_000_000 else None      # bornes de bon sens


def convertir(e):
    return {
        "id": e.get("id"),
        "date": e.get("dateparution"),
        "famille": e.get("familleavis") or e.get("familleavis_lib"),
        "type": e.get("typeavis_lib") or e.get("typeavis"),
        "ville": e.get("ville"),
        "code_postal": e.get("cp"),
        "commercant": e.get("commercant"),
        "tribunal": e.get("tribunal"),
        "prix_cession_eur": prix_de(e),
    }


def est_laverie(e):
    t = texte_de(e).lower()
    return any(m in t for m in MOTS_LAVERIE)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--departement", default=DEPARTEMENT)
    ap.add_argument("--diagnostic", action="store_true",
                    help="affiche une annonce brute et s'arrête")
    args = ap.parse_args()

    if args.diagnostic:
        rep = appeler({"where": f'numerodepartement="{args.departement}"', "limit": 1})
        print(json.dumps(rep, ensure_ascii=False, indent=2)[:6000])
        print("\n(envoyez ce bloc si le script ne trouve rien)")
        return

    if not ENTREPRISES.exists():
        sys.exit("❌ data/entreprises.json manquant. Lancez d'abord :\n"
                 "   python3 scripts/import_entreprises.py")

    if not joignable():
        sys.exit("❌ L'API BODACC ne répond pas. Vérifiez votre connexion "
                 "internet, puis relancez.")

    ent = json.loads(ENTREPRISES.read_text(encoding="utf-8"))
    sirens = sorted({e["siren"] for e in ent["etablissements"]
                     if e.get("siren") and e.get("est_laverie")})
    print(f"{len(sirens)} sociétés à interroger dans BODACC…\n")

    # On détermine la syntaxe acceptée sur le premier SIREN, puis on s'y tient.
    strategie = None
    for f in STRATEGIES:
        if sirens and interroger(f(sirens[0]), pages=1) is not None:
            strategie = f
            print(f"  syntaxe retenue : {f(sirens[0])}\n")
            break
    if strategie is None:
        sys.exit("❌ Aucune syntaxe de requête acceptée par l'API BODACC.\n"
                 "   Relancez avec --diagnostic et envoyez-moi la sortie.")

    annonces, par_siren = [], {}
    for i, siren in enumerate(sirens, 1):
        res = interroger(strategie(siren)) or []
        evenements = [convertir(e) for e in res]
        if evenements:
            par_siren[siren] = evenements
            annonces.extend(evenements)
        if i % 10 == 0 or i == len(sirens):
            print(f"  {i}/{len(sirens)} sociétés · {len(annonces)} annonces")
        time.sleep(0.2)

    # Balayage des cessions du département : donne des prix de transaction pour
    # des laveries absentes de l'inventaire.
    print("\nRecherche de cessions de laveries dans le département…")
    cessions = []
    for where in (f'numerodepartement="{args.departement}" and "laverie"',
                  f'numerodepartement="{args.departement}" and familleavis="vente"'):
        res = interroger(where, pages=10)
        if res:
            cessions = [convertir(e) for e in res if est_laverie(e)]
            if cessions:
                break

    prix = sorted(c["prix_cession_eur"] for c in cessions if c["prix_cession_eur"])
    familles = Counter(a["famille"] for a in annonces if a["famille"])
    radiations = [a for a in annonces if a["famille"] and "radiation" in str(a["famille"]).lower()]

    SORTIE.write_text(json.dumps({
        "meta": {
            "source": "BODACC — DILA, licence ouverte 2.0",
            "departement": args.departement,
            "societes_interrogees": len(sirens),
            "societes_avec_annonces": len(par_siren),
            "annonces": len(annonces),
            "radiations": len(radiations),
            "cessions_reperees": len(cessions),
            "prix_cession_eur": {
                "n": len(prix),
                "min": prix[0] if prix else None,
                "median": prix[len(prix) // 2] if prix else None,
                "max": prix[-1] if prix else None,
            },
            "familles": dict(familles),
            "avertissement": (
                "Le prix de cession est extrait du texte de l'annonce : il peut "
                "manquer ou porter sur un ensemble plus large que le seul fonds. "
                "À lire comme un ordre de grandeur, pas comme un barème."),
        },
        "par_siren": par_siren,
        "cessions": cessions,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n✅ {len(annonces)} annonces pour {len(par_siren)} sociétés")
    print(f"   {len(radiations)} radiations · {len(cessions)} cessions repérées")
    if prix:
        print(f"   Prix de cession observés : {prix[0]:,.0f} € à {prix[-1]:,.0f} €, "
              f"médiane {prix[len(prix) // 2]:,.0f} €".replace(",", " "))
    print(f"   → {SORTIE}")
    print("\n   Étape suivante : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
