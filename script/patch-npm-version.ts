#!/usr/bin/env ts-node

// If the version in package.json is less than or equal to
// the published version on GitHub registry, set the version to a patch
// on top of the published version so we can publish.

import * as shell from "shelljs";
import * as semver from "semver";
import * as fs from "fs";
import * as path from "path";

const GITHUB_USERNAME = "lanciermonitoring";
const PACKAGE_NAME = `@${GITHUB_USERNAME}/quicktype`;

function exec(command: string) {
    const result = shell.exec(command, { silent: true });
    return (result.stdout as string).trim();
}

// Read the package.json file properly
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const CURRENT = packageJson.version;

console.log(`* Current version in package.json: ${CURRENT}`);

const PUBLISHED = (() => {
    try {
        // Get the highest published version from GitHub registry
        const result = exec(`npm show ${PACKAGE_NAME} version --registry=https://npm.pkg.github.com 2>/dev/null`);

        // Check if the package doesn't exist (npm show returns an error)
        if (!result || result === '' || result.includes('E404') || result.includes('npm ERR!')) {
            console.log("* No previously published version found. This appears to be the first publish.");
            return null;
        }

        // The result should be a version string
        const version = result.trim();

        // Validate it's a valid semver string
        if (!semver.valid(version)) {
            console.log("* No valid version found. This appears to be the first publish.");
            return null;
        }

        return version;
    } catch (e) {
        console.log("* Error checking for published version. This appears to be the first publish.");
        console.log(`* Error details: ${e}`);
        return null;
    }
})();

if (PUBLISHED) {
    console.log(`* Latest published version: ${PUBLISHED}`);
    switch (semver.compare(CURRENT, PUBLISHED)) {
        case -1:
            console.error(
                `* package.json version is ${CURRENT} but ${PUBLISHED} is published. Patching...`,
            );
            exec(`npm version ${PUBLISHED} --force --no-git-tag-version`);
            shell.exec(`npm version patch --no-git-tag-version`);
            break;
        case 0:
            console.error(
                `* package.json version is ${CURRENT} but ${PUBLISHED} is published. Patching...`,
            );
            shell.exec(`npm version patch --no-git-tag-version`);
            break;
        default:
            console.log(`* Current version ${CURRENT} is greater than published ${PUBLISHED}. Good to go!`);
            break;
    }
} else {
    console.log(`* First time publishing version ${CURRENT}`);
}
