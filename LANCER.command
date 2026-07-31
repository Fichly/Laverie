#!/bin/bash
# Double-cliquez ce fichier dans le Finder pour ouvrir l'application.
# Il démarre un serveur local et ouvre votre navigateur sur la carte.
cd "$(dirname "$0")" || exit 1
clear
python3 scripts/servir.py
