#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbiddenFiles = [
  /^\.env(?:\.|$)/iu,
  /^google-services\.json$/iu,
  /^GoogleService-Info\.plist$/u,
  /service[-_]?account.*\.json$/iu,
  /\.(?:jks|keystore|p12|pfx|mobileprovision|pem|key)$/iu,
];

const forbiddenContent = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/u],
  ['GitHub token', /gh(?:p|o|u|s|r)_[0-9A-Za-z]{30,}/u],
  ['AWS access key', /(?:AKIA|ASIA)[0-9A-Z]{16}/u],
  ['Slack token', /xox(?:a|b|p|r|s)-[0-9A-Za-z-]{20,}/u],
  ['service-account private key', /["']private_key["']\s*:/u],
  ['concrete Firebase API key', /["']apiKey["']\s*:\s*["'][^$<{][^"']+["']/u],
  ['personal email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ['local home-directory path', /(?:\/Users\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/iu],
  ['consumer-specific secret name', /FIREBASE_SERVICE_ACCOUNT_[A-Z0-9_]+/u],
];

// The only packages this repository may name. Anything else is either a product
// that consumes the engine or a package that does not exist, and a reader
// arriving here has no way to resolve it. A shorter prefix of a declared name is
// accepted because storage keys and scopes are namespaced with one.
//
// This replaced a denylist of identifiers belonging to a specific consumer
// application. That list worked, but it spelled the consumer's names out in the
// one public file whose purpose is to keep them out — and it could only ever
// catch the leaks someone had already thought of. Naming what is allowed catches
// the rest by construction, and says nothing about anybody's product.
const declaredPackages = [
  'obsidian-eclipse-graphic-engine',
  'obsidian-eclipse-capacitor-plugins',
  'obsidian-eclipse-audio-engine',
];

const isDeclaredPackage = (name) =>
  declaredPackages.some((declared) => declared === name || declared.startsWith(`${name}-`));

const failures = [];

for (const file of trackedFiles) {
  if (forbiddenFiles.some((pattern) => pattern.test(basename(file)))) {
    failures.push(`${file}: forbidden credential or local-configuration file`);
    continue;
  }

  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');
  for (const [label, pattern] of forbiddenContent) {
    // Detection signatures are intentional here; literal email addresses never are.
    if (file === 'scripts/check-sensitive.mjs' && label !== 'personal email address') continue;
    if (pattern.test(content)) failures.push(`${file}: ${label}`);
  }

  for (const [name] of content.matchAll(/\bobsidian-eclipse-[a-z0-9-]+/gu)) {
    if (!isDeclaredPackage(name)) failures.push(`${file}: undeclared package reference "${name}"`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`✓ Sensitive-data check: ${trackedFiles.length} tracked files passed.`);
