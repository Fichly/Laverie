#!/bin/bash
# Double-cliquez ce fichier dans le Finder pour préparer l'application.
# Il se place tout seul dans le bon dossier, puis lance l'assistant.
cd "$(dirname "$0")" || exit 1
clear
python3 scripts/preparer.py
echo
echo "Vous pouvez fermer cette fenêtre."
