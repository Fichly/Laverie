#!/usr/bin/env python3
"""Assistant : prépare l'application avec toutes les données disponibles.

À QUOI SERT CE SCRIPT

L'application fonctionne dès le départ, mais avec des estimations. Pour la
rendre fiable, il faut lui donner quatre jeux de données, chacun récupéré par un
script différent. Les enchaîner à la main dans le bon ordre est pénible et
source d'erreurs — cet assistant s'en charge, explique chaque étape, et continue
même si l'une d'elles échoue.

    python3 scripts/preparer.py

Ou, sur Mac, double-cliquez sur PREPARER.command à la racine du projet.

Aucune donnée n'est inventée : si une source est indisponible, l'assistant le
dit et l'application le signalera dans son interface.
"""

import argparse
import getpass
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reseau                                              # noqa: E402

RACINE = Path(__file__).resolve().parent.parent
PY = sys.executable or "python3"

# Dossiers où l'on cherche le fichier INSEE téléchargé par l'utilisateur.
DOSSIERS_RECHERCHE = ["Downloads", "Téléchargements", "Desktop", "Bureau",
                      "Documents"]
MOTIFS_INSEE = ["carreaux*200m*.gpkg", "carreaux*200m*.parquet",
                "carreaux*200m*.csv", "*carreaux*.gpkg"]


# ─────────────────────────────────────────────────────────── affichage

LARGEUR = 74


def titre(n, total, texte):
    print("\n" + "━" * LARGEUR)
    print(f"  ÉTAPE {n}/{total} — {texte}")
    print("━" * LARGEUR)


def dire(texte, prefixe="   "):
    for ligne in texte.strip("\n").split("\n"):
        print(prefixe + ligne)


def demander(question, defaut=True):
    if NON_INTERACTIF:
        return defaut
    suffixe = " [O/n] " if defaut else " [o/N] "
    rep = input("\n   " + question + suffixe).strip().lower()
    if not rep:
        return defaut
    return rep.startswith("o") or rep.startswith("y")


# ─────────────────────────────────────────────────────────── utilitaires

def lancer(script, *args, env_sup=None):
    """Exécute un script du projet. Renvoie True si tout s'est bien passé."""
    env = dict(os.environ)
    if env_sup:
        env.update(env_sup)
    cmd = [PY, str(RACINE / "scripts" / script), *args]
    print()
    try:
        r = subprocess.run(cmd, cwd=RACINE, env=env)
        return r.returncode == 0
    except KeyboardInterrupt:
        print("\n   ⏹  Interrompu.")
        return False
    except Exception as e:                                  # noqa: BLE001
        dire(f"⚠ Impossible de lancer {script} : {e}")
        return False


def chercher_fichier_insee():
    """Cherche le carroyage INSEE dans les dossiers habituels de téléchargement."""
    maison = Path.home()
    trouves = []
    for dossier in DOSSIERS_RECHERCHE:
        base = maison / dossier
        if not base.is_dir():
            continue
        for motif in MOTIFS_INSEE:
            # Deux niveaux suffisent : le fichier est souvent dans un dossier
            # décompressé, rarement plus profond.
            trouves.extend(base.glob(motif))
            trouves.extend(base.glob("*/" + motif))
            trouves.extend(base.glob("*/*/" + motif))
    # Le plus gros fichier est le bon : la France entière pèse ~1 Go.
    trouves = sorted({f for f in trouves if f.is_file()},
                     key=lambda f: -f.stat().st_size)
    return trouves[0] if trouves else None


def taille_lisible(chemin):
    o = chemin.stat().st_size
    for unite in ("o", "Ko", "Mo", "Go"):
        if o < 1024 or unite == "Go":
            return f"{o:.0f} {unite}"
        o /= 1024
    return ""


def existe(nom):
    return (RACINE / "data" / nom).exists()


# ────────────────────────────────────────────────── vérification préalable

def verifier_reseau():
    """Teste HTTPS avant toute chose, et répare les certificats si besoin.

    Sur un Python installé depuis python.org, le magasin de certificats est vide
    et TOUTES les étapes réseau échouent d'un coup. Diagnostiquer ça après coup,
    à partir de deux traces d'erreur différentes, est décourageant : autant le
    voir tout de suite et proposer le correctif.
    """
    ok, motif = reseau.tester_https()
    if ok:
        return True

    if motif != "certificat":
        dire("""
⚠ Pas d'accès internet détecté.

  Les étapes 2 et 3 seront ignorées. L'étape 1 (population INSEE) fonctionne
  hors ligne : elle lit un fichier déjà sur votre disque.
""")
        return False

    print()
    dire(reseau.message_certificat())
    if not demander("Je lance le correctif automatiquement ?"):
        return False

    dire("Installation des certificats…")
    reseau.reparer_certificats()
    ok, _ = reseau.tester_https()
    if ok:
        dire("✅ Connexion HTTPS rétablie.")
    else:
        inst = reseau.installateur_macos()
        dire("❌ Toujours pas. Lancez le correctif à la main, puis relancez :\n\n"
             + (f'   open "{inst}"' if inst
                else "   python3 -m pip install --upgrade certifi"))
    return ok


# ─────────────────────────────────────────────────────────── les étapes

def etape_insee(bilan):
    titre(1, 4, "La population, quartier par quartier (INSEE)")
    dire("""
Sans cette donnée, le modèle répartit les habitants à la louche. Avec elle, il
connaît la population réellement observée par carré de 200 mètres.

C'est la donnée qui compte le plus. Elle est gratuite, mais c'est la seule que
vous devez télécharger vous-même (le fichier fait environ 1 Go).
""")

    if existe("carreaux.json"):
        dire("✅ Déjà importée. Je la remplace seulement si vous le demandez.")
        if not demander("Ré-importer (utile si l'ancien import s'arrêtait à Pessac) ?",
                        defaut=False):
            bilan["INSEE"] = "déjà présente (inchangée)"
            return

    fichier = chercher_fichier_insee()
    if not fichier:
        dire("""
❌ Je n'ai pas trouvé le fichier sur votre ordinateur.

Pour le récupérer :
  1. ouvrez insee.fr, cherchez « données carroyées 200 m Filosofi » ;
  2. téléchargez la version France métropolitaine, format GeoPackage (.gpkg) ;
  3. double-cliquez le .zip pour le décompresser ;
  4. relancez cet assistant.

L'application marchera quand même sans, avec des populations estimées.
""")
        bilan["INSEE"] = "❌ fichier introuvable — population estimée"
        return

    dire(f"📄 Fichier trouvé : {fichier}")
    dire(f"   ({taille_lisible(fichier)})")
    if not demander("J'utilise celui-ci ?"):
        bilan["INSEE"] = "ignorée à votre demande"
        return

    dire("Lecture en cours — quelques secondes malgré la taille du fichier…")
    ok = lancer("import_insee_carreaux.py", str(fichier))
    bilan["INSEE"] = "✅ importée" if ok else "❌ échec (voir le message ci-dessus)"


def etape_laveries(bilan, cle):
    titre(2, 4, "Les laveries de toute la métropole (Google)")
    dire("""
L'inventaire actuel couvre Pessac et ses abords. Pour travailler à l'échelle
des 28 communes, il faut recenser les laveries partout — sinon les communes
sans données ressortent faussement comme des opportunités.

Cette étape a besoin de votre clé Google. Elle coûte quelques centimes,
largement couverts par le crédit mensuel offert par Google.
""")

    if not cle:
        dire("⏭  Pas de clé fournie : j'ignore cette étape.")
        bilan["Laveries métropole"] = "⏭ ignorée (pas de clé Google)"
        return

    if not demander("Lancer le recensement (environ 1 minute) ?"):
        bilan["Laveries métropole"] = "ignorée à votre demande"
        return

    ok = lancer("find_laveries_metropole.py", "--ecrire",
                env_sup={"GOOGLE_MAPS_API_KEY": cle})
    bilan["Laveries métropole"] = "✅ recensées" if ok else "❌ échec"


def etape_entreprises(bilan):
    titre(3, 4, "Les chiffres d'affaires réels (SIRENE, greffes, BODACC)")
    dire("""
Aujourd'hui le modèle suppose qu'une laverie fait 50 000 € par an. Ce chiffre
vient d'un dossier de marché, personne ne l'a vérifié.

Ces deux sources publiques vont chercher les chiffres réellement déposés par
les sociétés de laverie : chiffre d'affaires, résultat, dates d'ouverture et de
fermeture, et même les prix auxquels des laveries se sont vendues.

Gratuit, sans clé, sans inscription. Comptez 2 à 5 minutes.
""")

    if not demander("Lancer la récupération ?"):
        bilan["Chiffres réels"] = "ignorée à votre demande"
        return

    ok = lancer("import_entreprises.py")
    bilan["Chiffres réels"] = "✅ récupérés" if ok else "❌ échec"

    if not ok:
        dire("""
Si le script n'a rien trouvé, relancez-le en mode diagnostic et envoyez-moi
ce qu'il affiche :

    python3 scripts/import_entreprises.py --diagnostic
""")
        bilan["Historique BODACC"] = "⏭ ignorée (dépend de l'étape précédente)"
        return

    dire("\nMaintenant l'historique : fermetures et prix de cession.")
    if demander("Lancer aussi cette partie (2 à 5 minutes) ?"):
        ok2 = lancer("import_bodacc.py")
        bilan["Historique BODACC"] = "✅ récupéré" if ok2 else "❌ échec"
    else:
        bilan["Historique BODACC"] = "ignorée à votre demande"


def etape_construction(bilan):
    titre(4, 4, "Fabrication de l'application")
    dire("""
Toutes les données récupérées sont assemblées dans un seul fichier
laverie-mapper.html, que vous ouvrez d'un double-clic. Rien à installer.
""")
    ok = lancer("build_standalone.py")
    bilan["Application"] = "✅ construite" if ok else "❌ échec"
    return ok


# ─────────────────────────────────────────────────────────── programme

NON_INTERACTIF = False


def main():
    global NON_INTERACTIF
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--auto", action="store_true",
                    help="ne pose aucune question, répond oui par défaut")
    ap.add_argument("--sans-google", action="store_true",
                    help="ignore l'étape qui demande la clé Google")
    args = ap.parse_args()
    NON_INTERACTIF = args.auto

    print("\n" + "═" * LARGEUR)
    print("  🧺  LAVERIE MAPPER — préparation des données")
    print("═" * LARGEUR)

    if not (RACINE / "data" / "laveries.json").exists():
        sys.exit(f"\n❌ Je ne trouve pas les données du projet dans {RACINE}.\n"
                 "   Lancez ce script depuis le dossier du projet.\n")

    dire(f"""
Dossier du projet : {RACINE}

Quatre étapes. Chacune est facultative : si l'une échoue ou si vous la sautez,
les autres se poursuivent et l'application vous dira ce qui lui manque.
""")

    reseau_ok = verifier_reseau()

    cle = None
    if not args.sans_google and reseau_ok:
        cle = os.environ.get("GOOGLE_MAPS_API_KEY")
        if cle:
            dire("🔑 Clé Google trouvée dans votre environnement.")
        elif not NON_INTERACTIF:
            dire("""
🔑 Une étape a besoin de votre clé Google Maps. Vous pouvez la coller
   maintenant (elle ne s'affichera pas et n'est écrite dans aucun fichier),
   ou appuyer simplement sur Entrée pour sauter cette étape.
""")
            try:
                cle = getpass.getpass("   Clé Google (Entrée pour passer) : ").strip() or None
            except (EOFError, KeyboardInterrupt):
                cle = None

    bilan = {}
    try:
        etape_insee(bilan)
        if reseau_ok:
            etape_laveries(bilan, cle)
            etape_entreprises(bilan)
        else:
            bilan["Laveries métropole"] = "⏭ ignorée (pas d'accès internet)"
            bilan["Chiffres réels"] = "⏭ ignorée (pas d'accès internet)"
            bilan["Historique BODACC"] = "⏭ ignorée (pas d'accès internet)"
        etape_construction(bilan)
    except KeyboardInterrupt:
        print("\n\n   ⏹  Interrompu. Les étapes déjà terminées sont conservées.")

    print("\n" + "═" * LARGEUR)
    print("  BILAN")
    print("═" * LARGEUR)
    for nom, etat in bilan.items():
        print(f"   {nom:<24} {etat}")

    fichier = RACINE / "laverie-mapper.html"
    if fichier.exists():
        print(f"""
   ✅ Votre application est prête :

      {fichier}

   Ouvrez-la d'un double-clic dans le Finder, ou tapez :

      open "{fichier}"
""")
    print("═" * LARGEUR + "\n")


if __name__ == "__main__":
    main()
