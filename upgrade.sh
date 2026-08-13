#!/usr/bin/env bash

export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"

nvm install node && nvm use node && nvm alias default node
npx npm-check-updates -u
npm install
