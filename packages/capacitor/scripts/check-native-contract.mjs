#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const contract = JSON.parse(read('native-plugin-contract.json'));
const pkg = JSON.parse(read('package.json'));
const facade = read('src/index.ts');
const failures = [];

const sameMembers = (actual, expected) => {
    const a = [...new Set(actual)].sort();
    const e = [...expected].sort();
    return a.length === e.length && a.every((value, index) => value === e[index]);
};

for (const plugin of contract.plugins) {
    const androidRel = `android/src/main/java/com/obsidian/eclipse/capacitorplugins/${plugin.className}.java`;
    const iosRel = `ios/Sources/ObsidianEclipseCapacitorPlugins/${plugin.className}.swift`;
    for (const path of [androidRel, iosRel]) {
        if (!existsSync(join(root, path))) failures.push(`${plugin.name}: missing file ${path}`);
    }
    if (!existsSync(join(root, androidRel)) || !existsSync(join(root, iosRel))) continue;

    const android = read(androidRel);
    const ios = read(iosRel);
    if (!android.includes(`@CapacitorPlugin(name = "${plugin.name}")`)) {
        failures.push(`${plugin.name}: Android annotation not aligned`);
    }
    if (!ios.includes(`public let jsName = "${plugin.name}"`)) {
        failures.push(`${plugin.name}: iOS jsName not aligned`);
    }
    if (!facade.includes(`registerPlugin<`) || !facade.includes(`>('${plugin.name}')`)) {
        failures.push(`${plugin.name}: registerPlugin missing from the TypeScript facade`);
    }

    const androidMethods = [...android.matchAll(/@PluginMethod\s+public void (\w+)\s*\(/g)].map((m) => m[1]);
    const iosMethods = [...ios.matchAll(/CAPPluginMethod\(name: "([^"]+)"/g)].map((m) => m[1]);
    if (!sameMembers(androidMethods, plugin.methods)) {
        failures.push(`${plugin.name}: Android methods ${androidMethods.sort().join(', ')} != contract ${plugin.methods.join(', ')}`);
    }
    if (!sameMembers(iosMethods, plugin.methods)) {
        failures.push(`${plugin.name}: iOS methods ${iosMethods.sort().join(', ')} != contract ${plugin.methods.join(', ')}`);
    }
}

for (const required of ['dist/', 'android/src/main/', 'ios/Sources', 'Package.swift', 'ObsidianEclipseCapacitorPlugins.podspec']) {
    if (!pkg.files?.includes(required)) failures.push(`package.json files does not include ${required}`);
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
}

console.log(`✓ Native plugin contract: ${contract.plugins.length} plugins, Android/iOS/TypeScript aligned.`);
