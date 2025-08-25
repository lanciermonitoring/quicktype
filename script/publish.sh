#!/usr/bin/env bash

set -e

GITHUB_USERNAME="lanciermonitoring"

./script/patch-npm-version.ts

VERSION=$(jq -r '.version' package.json )

# Update workspace versions only if they're different
echo "Setting all packages to version $VERSION"
for pkg in packages/*/package.json; do
    CURRENT_VERSION=$(jq -r '.version' "$pkg")
    if [ "$CURRENT_VERSION" != "$VERSION" ]; then
        echo "Updating $(dirname $pkg) from $CURRENT_VERSION to $VERSION"
        jq --arg version "$VERSION" '.version = $version' "$pkg" > "$pkg.tmp"
        mv "$pkg.tmp" "$pkg"
    fi
done

# Publish core
pushd packages/quicktype-core
# Update package name for GitHub registry
jq --arg name "@$GITHUB_USERNAME/quicktype-core" \
    --arg version "$VERSION" \
    '.name = $name | .version = $version | .publishConfig = {"registry": "https://npm.pkg.github.com"}' \
    package.json > package.1.json
mv package.1.json package.json
npm publish
popd

# Publish typescript input
pushd packages/quicktype-typescript-input
jq --arg version $VERSION \
   --arg name "@$GITHUB_USERNAME/quicktype-typescript-input" \
   --arg core "@$GITHUB_USERNAME/quicktype-core" \
    '.name = $name | .version = $version | .dependencies[$core] = $version | .publishConfig = {"registry": "https://npm.pkg.github.com"}' \
    package.json > package.1.json
mv package.1.json package.json
npm publish
popd

# Publish graphql input
pushd packages/quicktype-graphql-input
jq --arg version $VERSION \
   --arg name "@$GITHUB_USERNAME/quicktype-graphql-input" \
   --arg core "@$GITHUB_USERNAME/quicktype-core" \
    '.name = $name | .version = $version | .dependencies[$core] = $version | .publishConfig = {"registry": "https://npm.pkg.github.com"}' \
    package.json > package.1.json
mv package.1.json package.json
npm publish
popd

# Publish quicktype
jq --arg version $VERSION \
   --arg name "@$GITHUB_USERNAME/quicktype" \
   --arg core "@$GITHUB_USERNAME/quicktype-core" \
   --arg graphql "@$GITHUB_USERNAME/quicktype-graphql-input" \
   --arg typescript "@$GITHUB_USERNAME/quicktype-typescript-input" \
    '.name = $name | .version = $version | .dependencies[$core] = $version | .dependencies[$graphql] = $version | .dependencies[$typescript] = $version | .publishConfig = {"registry": "https://npm.pkg.github.com"}' \
    package.json > package.1.json
mv package.1.json package.json
npm publish
