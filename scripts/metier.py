"""Distingue une vraie laverie libre-service des faux positifs de Google.

POURQUOI C'EST CRITIQUE POUR LE MODÈLE

Une recherche « laverie » sur Google Places ramène aussi des stations de lavage
auto, des installateurs de matériel, des blanchisseries industrielles et des
pressings. Chacun de ces faux positifs devient, dans le modèle, un CONCURRENT
FANTÔME : il refroidit la carte autour de lui et fait disparaître une
opportunité qui existe réellement.

Trois verdicts plutôt que deux :

    garde    laverie libre-service, à conserver ;
    exclu    autre métier, certain — retiré des calculs ;
    douteux  ambigu — conservé, mais signalé pour vérification humaine.

On n'exclut jamais sur un doute : une exclusion à tort supprime un vrai
concurrent, ce qui est aussi faux qu'un concurrent fantôme.
"""

import re
import unicodedata


def normaliser(texte):
    if not texte:
        return ""
    t = unicodedata.normalize("NFD", str(texte))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9' ]+", " ", t)


# Autres métiers, sans ambiguïté possible.
EXCLUSIONS = [
    # Lavage de véhicules : « station de lavage », « sans rouleau », « lavauto »…
    ("station de lavage", "lavage automobile"),
    ("sans rouleau", "lavage automobile"),
    ("rouleaux", "lavage automobile"),
    ("lavage auto", "lavage automobile"),
    ("lav'auto", "lavage automobile"),
    ("lavauto", "lavage automobile"),
    ("car wash", "lavage automobile"),
    ("portique", "lavage automobile"),
    ("haute pression", "lavage automobile"),
    ("starwash", "lavage automobile"),
    # Fournisseurs et installateurs : ils vendent des machines, ils n'en exploitent pas.
    ("installation de laverie", "installateur de matériel"),
    ("installateur", "installateur de matériel"),
    ("hydronodis", "installateur de matériel"),
    ("distributeur", "fournisseur de matériel"),
    ("fournisseur", "fournisseur de matériel"),
    # Divers sans rapport.
    ("cavalbox", "van et box à chevaux"),
    ("cordonnerie", "autre commerce"),
]

# Métiers voisins : on n'exclut QUE si le nom ne dit pas aussi « laverie ».
# « Laverie Pressing du Coin » fait les deux : c'est un vrai concurrent.
EXCLUSIONS_SAUF_LAVERIE = [
    ("pressing", "pressing (dépôt avec personnel)"),
    ("nettoyage a sec", "pressing"),
]

# Doutes sur le MÉTIER : valent même quand le nom dit « laverie ».
DOUTES_METIER = [
    ("blanchisserie", "blanchisserie : vérifier que ce n'est pas de l'industriel B2B"),
    ("teinturerie", "teinturerie : probablement un pressing"),
]

# Doutes sur le FLOU du nom : ne valent que si aucun mot du métier n'apparaît.
# « Sarl Laverie du Port » ne pose aucun problème ; « Sarl Ô Bulles », si.
DOUTES_FLOU = [
    ("solutions", "nom d'entreprise : vérifier que c'est bien un point de lavage"),
    ("sarl", "raison sociale sans enseigne : adresse à confirmer"),
    ("services", "intitulé vague : à confirmer sur place"),
]

# Ces mots l'emportent : ils désignent sans ambiguïté une laverie libre-service.
CERTITUDES = ["laverie automatique", "laverie libre service", "laverie libre-service",
              "lavomatic", "lavomatique", "libre service", "wash'n dry", "speed queen",
              "revolution laundry", "au fil du linge", "lavoir"]


def classer(nom, adresse="", activite=""):
    """Renvoie (verdict, motif) où verdict vaut garde, exclu ou douteux.

    L'ordre compte. Les exclusions passent AVANT les certitudes : sinon
    « Installation de Laverie Automatique », qui vend des machines, serait
    conservé comme laverie au seul motif qu'il contient « laverie automatique ».

    Les exclusions ne portent que sur le nom et l'activité, jamais sur
    l'adresse : une rue peut s'appeler « du Lavoir » sans que le commerce
    change de métier.
    """
    n = normaliser(nom)
    signature = " ".join([n, normaliser(activite)])
    est_laverie = "laverie" in n or any(normaliser(m) in n for m in CERTITUDES)

    for motif, raison in EXCLUSIONS:
        if normaliser(motif) in signature:
            return "exclu", raison

    for motif, raison in EXCLUSIONS_SAUF_LAVERIE:
        if normaliser(motif) in signature and not est_laverie:
            return "exclu", raison

    for motif, raison in DOUTES_METIER:
        if normaliser(motif) in n:
            return "douteux", raison

    if est_laverie:
        return "garde", None

    for motif, raison in DOUTES_FLOU:
        if normaliser(motif) in n:
            return "douteux", raison
    if "lavage du linge" in signature:
        return "garde", None

    return "douteux", "aucun mot du métier dans le nom"
