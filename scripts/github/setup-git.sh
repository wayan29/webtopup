#!/bin/bash

set -e

echo "Setting up global git configuration..."

if ! command -v git >/dev/null 2>&1; then
    echo "Git belum terpasang."
    exit 1
fi

git config --global user.name "wayan29"
git config --global user.email "wayan29@users.noreply.github.com"
git config --global init.defaultBranch main
git config --global push.default simple

echo
echo "Current git configuration:"
git config --list --global | grep -E "(user\.|init\.defaultBranch|push\.default)" || true

echo
echo "Next steps:"
echo "1. Review docs/github/READY_TO_UPLOAD.md"
echo "2. Run: npm run github:upload"
