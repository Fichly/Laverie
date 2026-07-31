#!/usr/bin/env python3
"""Construit `laverie-mapper.html` : un fichier HTML unique, ouvrable d'un
double-clic, sans serveur ni installation.

    python3 scripts/build_standalone.py

Le script inline Leaflet, la feuille de style, le code de l'application et les
trois fichiers de données. Seules les tuiles de fond de carte restent chargées
depuis OpenStreetMap : une connexion internet est donc nécessaire pour voir le
fond de plan (le reste fonctionne hors ligne).

À relancer après chaque modification de data/*.json pour régénérer le fichier.
"""

import json
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "laverie-mapper.html"


def lire(chemin):
    return (RACINE / chemin).read_text(encoding="utf-8")


def main():
    donnees = {
        "laveries": json.loads(lire("data/laveries.json")),
        "quartiers": json.loads(lire("data/quartiers.json")),
        "benchmarks": json.loads(lire("data/benchmarks.json")),
        "generateurs": json.loads(lire("data/generateurs.json")),
        # Sans les 28 communes, le mode métropole n'a plus aucune zone d'étude :
        # l'emprise de la heatmap se calcule sur une liste vide et le rendu
        # échoue. Oubli invisible tant qu'on ne teste que la version modulaire.
        "communes": json.loads(lire("data/communes.json")),
    }
    # Facultatifs : présents seulement après le script d'import correspondant.
    for cle, chemin in (("carreaux", "data/carreaux.json"),
                        ("entreprises", "data/entreprises.json"),
                        ("bodacc", "data/bodacc.json")):
        donnees[cle] = (json.loads(lire(chemin))
                        if (RACINE / chemin).exists() else None)

    # On repart de index.html et on remplace les balises externes par leur contenu.
    html = lire("index.html")
    remplacements = [
        ('<link rel="stylesheet" href="vendor/leaflet.css">',
         "<style>\n" + lire("vendor/leaflet.css") + "\n</style>"),
        ('<link rel="stylesheet" href="css/style.css">',
         "<style>\n" + lire("css/style.css") + "\n</style>"),
        ('<script src="vendor/leaflet.js"></script>',
         "<script>\n" + lire("vendor/leaflet.js") + "\n</script>"),
        ('<script src="vendor/leaflet-heat.js"></script>',
         "<script>\n" + lire("vendor/leaflet-heat.js") + "\n</script>"),
        ('<script src="js/app.js"></script>',
         "<script>\nwindow.__DATA__ = "
         + json.dumps(donnees, ensure_ascii=False)
         + ";\n</script>\n<script>\n" + lire("js/app.js") + "\n</script>"),
    ]

    for cible, contenu in remplacements:
        if cible not in html:
            raise SystemExit(f"Balise introuvable dans index.html : {cible}")
        html = html.replace(cible, contenu)

    SORTIE.write_text(html, encoding="utf-8")
    taille = SORTIE.stat().st_size / 1024
    nb = len(donnees["laveries"]["laveries"])
    print(f"✅ {SORTIE.name} généré ({taille:.0f} Ko, {nb} laveries) — "
          f"ouvrable d'un double-clic.")


if __name__ == "__main__":
    main()
