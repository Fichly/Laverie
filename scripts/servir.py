#!/usr/bin/env python3
"""Sert l'application en local et ouvre le navigateur.

POURQUOI UN SERVEUR PLUTÔT QUE LE DOUBLE-CLIC

Ouvrir laverie-mapper.html d'un double-clic fonctionne, mais fige les données au
moment de la construction du fichier. Servi en local, c'est index.html qui
s'affiche : il va chercher data/*.json à chaque chargement. Corriger un nombre
de logements ou relancer un import se voit alors d'un simple rafraîchissement,
sans reconstruire quoi que ce soit.

    python3 scripts/servir.py              # port libre à partir de 8000
    python3 scripts/servir.py --port 9000
    python3 scripts/servir.py --sans-navigateur

Sur Mac, double-cliquez LANCER.command à la racine du projet.

Arrêt : Ctrl-C, ou fermez la fenêtre.
"""

import argparse
import http.server
import socket
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
PORT_DEFAUT = 8000
LARGEUR = 74


class Serveur(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(RACINE), **kwargs)

    def end_headers(self):
        # Sans cela, le navigateur ressert un data/laveries.json périmé après un
        # import : on croit que le script n'a rien fait alors que c'est le cache.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        # Une ligne par tuile de carte noierait l'URL à retenir.
        code = str(args[1]) if len(args) > 1 else ""
        if code.startswith(("4", "5")) and "carreaux.json" not in str(args[0]):
            sys.stderr.write(f"   ⚠ {args[0]} → {code}\n")


def port_libre(depart):
    """Premier port disponible à partir de `depart`.

    Relancer le serveur après un arrêt brutal, ou en avoir deux ouverts, ne doit
    pas se solder par un « Address already in use » sans explication.
    """
    for port in range(depart, depart + 40):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT_DEFAUT)
    ap.add_argument("--sans-navigateur", action="store_true",
                    help="n'ouvre pas le navigateur automatiquement")
    args = ap.parse_args()

    if not (RACINE / "index.html").exists():
        sys.exit(f"❌ index.html introuvable dans {RACINE}.\n"
                 "   Lancez ce script depuis le dossier du projet.")

    port = port_libre(args.port)
    if port is None:
        sys.exit(f"❌ Aucun port libre entre {args.port} et {args.port + 40}.")

    url = f"http://localhost:{port}/"
    socketserver.TCPServer.allow_reuse_address = True

    print("\n" + "═" * LARGEUR)
    print("  🧺  LAVERIE MAPPER — serveur local")
    print("═" * LARGEUR)
    print(f"""
   Votre lien :

      {url}

   Il est ouvert automatiquement dans votre navigateur. Sinon, copiez-le.

   Cette version lit les fichiers de data/ à chaque chargement : après un
   import ou une correction, un simple rafraîchissement (⌘R) suffit.

   Version figée, sans serveur : {url}laverie-mapper.html

   Pour arrêter : Ctrl-C dans cette fenêtre.
""")
    print("═" * LARGEUR + "\n")

    if not args.sans_navigateur:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        with socketserver.ThreadingTCPServer(("", port), Serveur) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n   ⏹  Serveur arrêté. Relancez avec : python3 scripts/servir.py\n")


if __name__ == "__main__":
    main()
