#!/usr/bin/env node
/**
 * Build manifest.json: the full content of this repository in the shape
 * described by schema/w3os-content.schema.json, then validate it against
 * that schema.
 *
 * The manifest is committed. CI rebuilds it and fails if the committed copy
 * is stale, so consumers such as the Sentry sync engine can read structured
 * guide items from a single, validated file instead of re-parsing markdown.
 *
 * Usage: node scripts/build-manifest.js [--check]
 *   --check  do not write; exit non-zero if manifest.json differs from the build
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib/w3os-content');

const ROOT = path.resolve(__dirname, '..');
const GUIDES_DIR = path.join(ROOT, 'guides');
const REQUIREMENTS_DIR = path.join(ROOT, 'requirements');
const SCHEMA = path.join(ROOT, 'schema', 'w3os-content.schema.json');
const OUT = path.join(ROOT, 'manifest.json');

function buildGuides() {
  const guides = [];
  for (const file of lib.getAllFiles(GUIDES_DIR)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const content = fs.readFileSync(file, 'utf8');
    const meta = lib.parseHtmlCommentMetadata(content);
    if (!meta || !meta.id || !meta.type || !meta.scope) continue;

    const title = lib.extractGuideTitle(content, path.basename(file));
    const category = lib.determineCategory(rel);
    const description = lib.extractGuideDescription(content, title, category);
    const checklistItems = lib.extractChecklistItems(content);
    if (checklistItems.length === 0) continue;

    const guide = {
      w3osId: meta.id,
      type: meta.type.toUpperCase(),
      title,
      description,
      category,
      scope: meta.scope.toUpperCase(),
      path: rel,
      checklistItems,
    };

    const parsed = lib.parseGuideItems(content);
    if (parsed.structured && parsed.errors.length === 0) {
      guide.items = parsed.items;
    }
    guides.push(guide);
  }
  return guides.sort((a, b) => a.w3osId.localeCompare(b.w3osId));
}

function buildDomains() {
  return lib
    .getAllFiles(REQUIREMENTS_DIR)
    .map(lib.parseDomainFile)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

function build() {
  return { domains: buildDomains(), guides: buildGuides() };
}

function main() {
  const check = process.argv.includes('--check');
  const manifest = build();
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const problems = lib.validateAgainstSchema(manifest, schema, schema);
  if (problems.length > 0) {
    console.error(`manifest does not match schema (${problems.length} problem(s)):`);
    problems.slice(0, 50).forEach(p => console.error('  ' + p));
    process.exit(1);
  }

  const json = JSON.stringify(manifest, null, 2) + '\n';
  const structured = manifest.guides.filter(g => g.items).length;
  const summary = `${manifest.domains.length} domains, ${manifest.guides.length} guides (${structured} with structured items)`;

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== json) {
      console.error('manifest.json is stale. Run: node scripts/build-manifest.js');
      process.exit(1);
    }
    console.log(`manifest.json is up to date: ${summary}`);
    return;
  }

  fs.writeFileSync(OUT, json);
  console.log(`Wrote manifest.json: ${summary}`);
}

if (require.main === module) main();
module.exports = { build };
