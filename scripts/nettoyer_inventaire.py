#!/usr/bin/env python3
"""Retire de l'inventaire les établissements qui ne sont pas des laveries.

POURQUOI

Le balayage Google ramène tout ce qui contient « lavage » ou « laverie » : des
stations de lavage auto, des installateurs de machines, des pressings. Laissés
dans l'inventaire, ils deviennent des CONCURRENTS FANTÔMES — ils refroidissent
la carte autour d'eux et masquent de vraies opportunités.

    python3 scripts/nettoyer_inventaire.py            # propose, n'écrit rien
    python3 scripts/nettoyer_inventaire.py --ecrire   # applique

Les exclus ne sont pas supprimés : leur `statut` passe à « exclu » avec le
motif. Ils disparaissent des calculs, mais restent dans le fichier — vous pouvez
en réactiver un en remettant son statut à « actif ».

Les cas douteux ne sont PAS touchés : ils sont seulement listés, à vous de
trancher. Exclure à tort un vrai concurrent est aussi faux que garder un faux.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import metier                                              # noqa: E402

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data" / "laveries.json"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ecrire", action="store_true",
                    help="applique les exclusions à data/laveries.json")
    ap.add_argument("--reactiver", action="store_true",
                    help="remet tous les exclus en actif, puis reclasse")
    args = ap.parse_args()

    inventaire = json.loads(DATA.read_text(encoding="utf-8"))
    laveries = inventaire["laveries"]

    if args.reactiver:
        for l in laveries:
            if l.get("statut") == "exclu":
                l["statut"] = "actif"
                l.pop("motif_exclusion", None)

    exclus, douteux = [], []
    for l in laveries:
        if l.get("statut") not in ("actif", "exclu"):
            continue
        verdict, motif = metier.classer(l.get("nom", ""), l.get("adresse", ""),
                                        l.get("enseigne", "") or "")
        if verdict == "exclu":
            exclus.append((l, motif))
        elif verdict == "douteux":
            douteux.append((l, motif))

    print(f"\n{len(laveries)} établissements dans l'inventaire\n")

    if exclus:
        print(f"❌ {len(exclus)} à exclure — autre métier :\n")
        for l, motif in exclus:
            print(f"   {l['nom'][:56]:<58} {motif}")
    else:
        print("✅ Aucun faux positif certain.")

    if douteux:
        print(f"\n⚠ {len(douteux)} à vérifier — conservés, à trancher par vous :\n")
        for l, motif in douteux:
            print(f"   {l['nom'][:56]:<58} {motif}")
        print("\n   Pour en retirer un : ouvrez sa fiche dans l'application, ou "
              "passez son\n   « statut » à « exclu » dans data/laveries.json.")

    actifs = sum(1 for l in laveries if l.get("statut") == "actif")
    print(f"\nAprès nettoyage : {actifs - len(exclus)} laveries actives "
          f"(contre {actifs} aujourd'hui)")

    if not args.ecrire:
        print("\nRien écrit — relancez avec --ecrire pour appliquer.")
        return

    for l, motif in exclus:
        l["statut"] = "exclu"
        l["motif_exclusion"] = motif
    DATA.write_text(json.dumps(inventaire, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    print(f"\n✅ {len(exclus)} établissements exclus → {DATA}")
    print("   Régénérer l'application : python3 scripts/build_standalone.py")


if __name__ == "__main__":
    main()
