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
  ['legacy consumer identifier', /(?:SOAP_BUBBLE|BubbleFragments|registerSoapBubble|FIREBASE_SERVICE_ACCOUNT_[A-Z0-9_]+)/u],
];

const failures = [];

for (const file of trackedFiles) {
  if (forbiddenFiles.some((pattern) => pattern.test(basename(file)))) {
    failures.push(`${file}: forbidden credential or local-configuration file`);
    continue;
  }

  // This checker necessarily contains the signatures it detects.
  if (file === 'scripts/check-sensitive.mjs') continue;

  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');
  for (const [label, pattern] of forbiddenContent) {
    if (pattern.test(content)) failures.push(`${file}: ${label}`);
  }
}

const authorEmails = execFileSync('git', ['log', '--format=%ae'], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean);
for (const email of new Set(authorEmails)) {
  if (!email.endsWith('@users.noreply.github.com')) {
    failures.push('git history: commit author email is not a GitHub noreply address');
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`✓ Sensitive-data check: ${trackedFiles.length} tracked files and Git author metadata passed.`);
