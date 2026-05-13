#!/bin/bash
echo "🚀 Start: Git installeren..."
sudo apt update && sudo apt install git -y

echo "🔑 SSH-sleutel genereren voor GitHub..."
# We maken een sleutel aan zonder wachtwoord (passphrase) zodat geautomatiseerde scripts niet vastlopen
ssh-keygen -t ed25519 -C "ubuntu-server-matchapp" -f ~/.ssh/id_ed25519 -N ""

echo "================================================================="
echo "✅ ACTIE VEREIST:"
echo "Kopieer de onderstaande sleutel en voeg deze toe aan GitHub."
echo "Ga naar je repo (ROosterloo1988/matchapp) -> Settings -> Deploy keys -> Add deploy key."
echo "Vink 'Allow write access' AAN als je script 3 (Release) vanaf de server wilt gebruiken."
echo "================================================================="
cat ~/.ssh/id_ed25519.pub
echo "================================================================="
echo "Als je dit gedaan hebt, draai dan het volgende commando om de connectie te testen:"
echo "ssh -T git@github.com"
