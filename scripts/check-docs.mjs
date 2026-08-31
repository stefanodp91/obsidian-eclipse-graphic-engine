#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

function collectMarkdown(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdown(path));
    else if (extname(entry.name).toLowerCase() === '.md') files.push(path);
  }
  return files;
}

const failures = [];
const markdownFiles = collectMarkdown(root);
let mermaidBlocks = 0;

const italianResidue = /[àèéìòùÀÈÉÌÒÙ]|\b(?:questo|questa|della|delle|degli|perché|gioco|vecchio|precedente|verifica|decisione|indice|ottimizzazioni|convenzioni)\b/iu;
const legacyReference = /wiki\/(?:log\.md|performance\/|ci\/)|engine-extraction-feasibility|firebase-console-setup|ottimizzazioni-batteria/u;

for (const file of markdownFiles) {
  const content = readFileSync(file, 'utf8');
  const relativeFile = file.slice(root.length + 1);

  const fenceCount = [...content.matchAll(/^```/gmu)].length;
  if (fenceCount % 2 !== 0) failures.push(`${relativeFile}: unbalanced fenced code block`);

  mermaidBlocks += [...content.matchAll(/^```mermaid\s*$/gmu)].length;

  const languageMatch = italianResidue.exec(content);
  if (languageMatch) {
    failures.push(`${relativeFile}: non-English residue "${languageMatch[0]}"`);
  }

  const legacyMatch = legacyReference.exec(content);
  if (legacyMatch) {
    failures.push(`${relativeFile}: legacy documentation reference "${legacyMatch[0]}"`);
  }

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1].trim().replace(/^<|>$/gu, '');
    if (!rawTarget || /^(?:https?:|mailto:|#)/u.test(rawTarget)) continue;
    const pathTarget = rawTarget.split('#')[0];
    if (!existsSync(resolve(dirname(file), pathTarget))) {
      failures.push(`${relativeFile}: missing relative link target "${rawTarget}"`);
    }
  }
}

if (mermaidBlocks === 0) failures.push('documentation: at least one Mermaid diagram is required');

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`✓ Documentation: ${markdownFiles.length} Markdown files, ${mermaidBlocks} Mermaid diagrams, links and language checks passed.`);
