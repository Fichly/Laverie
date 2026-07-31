"""Diagnostic des erreurs réseau, en français, et réparation des certificats.

POURQUOI CE MODULE EXISTE

Le piège le plus fréquent sur Mac n'a rien à voir avec le projet : un Python
installé depuis python.org arrive avec un magasin de certificats VIDE. Il
n'utilise pas celui de macOS. Toute connexion HTTPS échoue alors avec :

    SSL: CERTIFICATE_VERIFY_FAILED — unable to get local issuer certificate

Sans explication, l'utilisateur conclut que sa connexion, sa clé API ou le code
sont en cause, et cherche au mauvais endroit. Ce module reconnaît l'erreur,
l'explique, et sait lancer le correctif officiel.
"""

import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Adresse de test : joignable partout, et sans rapport avec les API du projet,
# pour que l'échec désigne bien la configuration locale et non un service.
URL_TEST = "https://www.google.com/generate_204"


def est_erreur_certificat(e):
    """Vrai si l'exception vient d'une chaîne de certificats non vérifiable."""
    if isinstance(e, ssl.SSLCertVerificationError):
        return True
    texte = str(e)
    return ("CERTIFICATE_VERIFY_FAILED" in texte
            or "unable to get local issuer certificate" in texte)


def installateur_macos():
    """Chemin du « Install Certificates.command » livré avec Python sur macOS."""
    if sys.platform != "darwin":
        return None
    v = f"{sys.version_info.major}.{sys.version_info.minor}"
    for chemin in (Path(f"/Applications/Python {v}/Install Certificates.command"),
                   Path(sys.prefix) / "Install Certificates.command"):
        if chemin.exists():
            return chemin
    return None


def message_certificat():
    """Explication complète, prête à afficher."""
    inst = installateur_macos()
    lignes = [
        "❌ Connexion HTTPS refusée : votre Python n'a pas de certificats.",
        "",
        "   Ce n'est ni votre connexion, ni votre clé API, ni le projet.",
        "   Un Python installé depuis python.org n'utilise pas les certificats",
        "   de macOS : il faut les installer une fois, et c'est réglé pour de bon.",
        "",
    ]
    if inst:
        lignes += ["   Correctif — copiez cette ligne dans le Terminal :", "",
                   f'      open "{inst}"', "",
                   "   Une fenêtre s'ouvre, affiche « done », et se ferme.",
                   "   Relancez ensuite ce script."]
    else:
        lignes += ["   Correctif :", "",
                   "      python3 -m pip install --upgrade certifi", "",
                   "   Puis relancez ce script."]
    return "\n".join(lignes)


def reparer_certificats():
    """Lance le correctif officiel. Renvoie True si la réparation a abouti."""
    inst = installateur_macos()
    if inst:
        try:
            r = subprocess.run(["/bin/bash", str(inst)], capture_output=True,
                               text=True, timeout=180)
            if r.returncode == 0:
                return True
        except Exception:                                   # noqa: BLE001
            pass
    # Repli : certifi seul suffit souvent, urllib le trouvant via SSL_CERT_FILE.
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade",
                        "certifi"], capture_output=True, text=True, timeout=180)
        import certifi                                      # noqa: PLC0415
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        return True
    except Exception:                                       # noqa: BLE001
        return False


def tester_https(url=URL_TEST, delai=12):
    """Teste une connexion HTTPS.

    Renvoie (True, None) si tout va bien, sinon (False, motif) où motif vaut
    'certificat' ou 'reseau'.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "laverie-mapper"})
        with urllib.request.urlopen(req, timeout=delai):
            return True, None
    except urllib.error.HTTPError:
        return True, None                    # le serveur répond : la voie est libre
    except Exception as e:                                  # noqa: BLE001
        return False, ("certificat" if est_erreur_certificat(e) else "reseau")


def joignable(url, delai=12):
    """Comme tester_https, mais sur l'API demandée. Renvoie (bool, motif)."""
    return tester_https(url, delai)


def expliquer_echec(motif, service, indice=""):
    """Message d'arrêt, adapté à la cause réelle."""
    if motif == "certificat":
        return message_certificat()
    return "\n".join([
        f"❌ {service} ne répond pas.",
        "",
        "   Vérifiez votre connexion internet, puis relancez.",
        "   Si vous êtes sur un réseau d'entreprise ou derrière un VPN, il bloque",
        "   peut-être ce service — essayez depuis une connexion personnelle.",
    ] + ([f"   {indice}"] if indice else []))
