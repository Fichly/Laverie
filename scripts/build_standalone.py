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
        # Facultatif : présent seulement après import_insee_carreaux.py
        "carreaux": (json.loads(lire("data/carreaux.json"))
                     if (RACINE / "data" / "carreaux.json").exists() else None),
    }

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

    html = html.replace(
        "<title>Laverie Mapper — Pessac (pilote)</title>",
        "<title>Laverie Mapper — Pessac (version autonome)</title>",
    )

    SORTIE.write_text(html, encoding="utf-8")
    taille = SORTIE.stat().st_size / 1024
    nb = len(donnees["laveries"]["laveries"])
    print(f"✅ {SORTIE.name} généré ({taille:.0f} Ko, {nb} laveries) — "
          f"ouvrable d'un double-clic.")


if __name__ == "__main__":
    main()
