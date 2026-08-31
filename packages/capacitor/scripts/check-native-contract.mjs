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
        if (!existsSync(join(root, path))) failures.push(`${plugin.name}: file mancante ${path}`);
    }
    if (!existsSync(join(root, androidRel)) || !existsSync(join(root, iosRel))) continue;

    const android = read(androidRel);
    const ios = read(iosRel);
    if (!android.includes(`@CapacitorPlugin(name = "${plugin.name}")`)) {
        failures.push(`${plugin.name}: annotazione Android non allineata`);
    }
    if (!ios.includes(`public let jsName = "${plugin.name}"`)) {
        failures.push(`${plugin.name}: jsName iOS non allineato`);
    }
    if (!facade.includes(`registerPlugin<`) || !facade.includes(`>('${plugin.name}')`)) {
        failures.push(`${plugin.name}: registerPlugin assente dal facade TypeScript`);
    }

    const androidMethods = [...android.matchAll(/@PluginMethod\s+public void (\w+)\s*\(/g)].map((m) => m[1]);
    const iosMethods = [...ios.matchAll(/CAPPluginMethod\(name: "([^"]+)"/g)].map((m) => m[1]);
    if (!sameMembers(androidMethods, plugin.methods)) {
        failures.push(`${plugin.name}: metodi Android ${androidMethods.sort().join(', ')} != contratto ${plugin.methods.join(', ')}`);
    }
    if (!sameMembers(iosMethods, plugin.methods)) {
        failures.push(`${plugin.name}: metodi iOS ${iosMethods.sort().join(', ')} != contratto ${plugin.methods.join(', ')}`);
    }
}

for (const required of ['dist/', 'android/src/main/', 'ios/Sources', 'Package.swift', 'ObsidianEclipseCapacitorPlugins.podspec']) {
    if (!pkg.files?.includes(required)) failures.push(`package.json files non include ${required}`);
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
}

console.log(`✓ Contratto plugin nativi: ${contract.plugins.length} plugin, Android/iOS/TypeScript allineati.`);
