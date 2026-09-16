/**
 * Shared parsing for W3OS content.
 *
 * Everything the sync engine derives from this repository is derived here too,
 * with the same rules, so the manifest this repo publishes and the data the
 * engine ingests cannot drift apart. Keep this file dependency-free.
 */

const fs = require('fs');
const path = require('path');

// -- Files -------------------------------------------------------------------

function getAllFiles(dir, ext = '.md') {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllFiles(full, ext));
    else if (entry.isFile() && entry.name.endsWith(ext)) results.push(full);
  }
  return results.sort();
}

// -- Guide metadata and header fields ----------------------------------------

function parseHtmlCommentMetadata(content) {
  const result = {};
  const pattern = /<!--\s*([\s\S]*?)\s*-->/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const lines = match[1].includes('\n') ? match[1].split('\n') : [match[1]];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.substring(0, colonIdx).trim();
      let value = trimmed.substring(colonIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!result[key]) result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function extractGuideTitle(content, filename) {
  let m = content.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (m) return m[1].trim();
  m = content.match(/<h2><a[^>]*>([^<]+)<\/a>\s*Configuration Guide<\/h2>/);
  if (m) return `${m[1]} Configuration`;
  m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].replace(/\*\*/g, '').trim();
  return filename
    .replace('.md', '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

function formatCategoryName(folderName) {
  switch (folderName) {
    case 'business-tools':
      return 'Business Tools';
    case 'communication-platforms':
      return 'Communication Platforms';
    case 'devops-accounts':
      return 'DevOps Accounts';
    default:
      return folderName
        .replace(/-/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .replace('Devops', 'DevOps');
  }
}

function determineCategory(relPath) {
  const parts = relPath.split('/');
  for (const part of parts) {
    if (part === 'business-tools') return 'Business Tools';
    if (part === 'communication-platforms') return 'Communication Platforms';
    if (part === 'devops-accounts') return 'DevOps Accounts';
  }
  if (relPath.includes('account configurations')) {
    const m = relPath.match(/account configurations\/[^/]+\/([^/]+)/);
    if (m) return formatCategoryName(m[1]);
  }
  return 'General Security';
}

function extractGuideDescription(content, title, category) {
  if (category !== 'General Security') {
    return `Security configuration guide for ${title.replace(' Configuration', '')}`;
  }
  let m = content.match(/##\s+Overview\s*\n\n(.*?)(?=\n##|\n---|\n\*\*|$)/s);
  if (m) return m[1].trim().replace(/\n/g, ' ').substring(0, 500);
  m = content.match(/^#.*?\n\n(.*?)(?=\n##|\n---|\n\*\*|$)/s);
  if (m) return m[1].trim().replace(/\n/g, ' ').substring(0, 500);
  return `Security guide for ${title.toLowerCase()}`;
}

// -- Checklist items ---------------------------------------------------------

function cleanChecklistItem(item) {
  return item
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\*+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The flat string list the sync engine keys progress on. */
function extractChecklistItems(content) {
  const items = [];
  for (const m of content.matchAll(/^[ \t]*- \[\s*\]\s+(.+)$/gm)) {
    const clean = cleanChecklistItem(m[1].trim());
    if (clean && !items.includes(clean)) items.push(clean);
  }
  return items;
}

const ITEM_LINE = /^- \[ \] \*\*(.+?)\*\*(?:\s+-\s+pass:\s*(.+))?\s*$/;
const BLOCK_LINE = /^  - \*\*([A-Za-z]+)\*\*:\s*$/;
const LABEL_LINE = /^    - ([A-Za-z]+):\s*(.*)$/;
const FENCE_OPEN = /^(\s*)```([a-z]*)\s*$/;
const FENCE_CLOSE = /^(\s*)```\s*$/;

const BLOCKS = ['Console', 'CLI'];
const LABELS = { Console: ['Verify', 'Fix'], CLI: ['Verify', 'Expect', 'Fix'] };
const FENCE_INDENT = 6;

/**
 * Parse a guide's checklist items into the structured shape described in
 * schema/guide-format.md. Every `- [ ]` line yields an item; Console and CLI
 * blocks are attached when present. Structural problems are returned as
 * errors with line numbers rather than thrown, so the validator can report
 * all of them at once.
 *
 * Returns { items, structured, errors }. `structured` is true when the guide
 * uses at least one Console or CLI block, which is what turns the format rules on.
 */
function parseGuideItems(content) {
  const lines = content.split('\n');
  const items = [];
  const errors = [];
  let item = null;
  let block = null;
  let blockName = null;
  let label = null;
  let structured = false;

  const err = (lineNo, msg) => errors.push({ line: lineNo + 1, message: msg });

  const closeItem = () => {
    item = null;
    block = null;
    blockName = null;
    label = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const itemMatch = line.match(ITEM_LINE);
    if (itemMatch) {
      closeItem();
      item = { title: itemMatch[1].trim(), line: i + 1 };
      if (itemMatch[2]) item.pass = itemMatch[2].trim();
      items.push(item);
      continue;
    }

    if (/^[ \t]+- \[ \]/.test(line)) {
      err(i, 'nested checkbox: sub-steps must be plain "-" bullets, never "- [ ]"');
      continue;
    }

    if (!item) continue;

    // Anything unindented ends the item.
    if (line.trim() !== '' && !/^\s/.test(line)) {
      closeItem();
      continue;
    }

    const blockMatch = line.match(BLOCK_LINE);
    if (blockMatch) {
      blockName = blockMatch[1];
      label = null;
      if (!BLOCKS.includes(blockName)) {
        err(i, `unknown block "${blockName}" (expected ${BLOCKS.join(' or ')})`);
        block = null;
        continue;
      }
      structured = true;
      const key = blockName.toLowerCase();
      if (item[key]) err(i, `duplicate ${blockName} block in item "${item.title}"`);
      block = blockName === 'Console' ? {} : { verify: [], fix: [] };
      item[key] = block;
      continue;
    }

    const labelMatch = line.match(LABEL_LINE);
    if (labelMatch) {
      label = labelMatch[1];
      const text = labelMatch[2].trim();
      if (!block) {
        err(i, `"${label}:" line outside a Console or CLI block`);
        label = null;
        continue;
      }
      if (!LABELS[blockName].includes(label)) {
        err(i, `unknown label "${label}" in ${blockName} block (expected ${LABELS[blockName].join(', ')})`);
        label = null;
        continue;
      }
      // A label with no text must be followed by a fenced block.
      if (text === '') {
        const next = lines[i + 1] || '';
        const fence = next.match(FENCE_OPEN);
        if (!fence) {
          err(i, `"${label}:" has no text and no fenced block on the next line`);
          continue;
        }
        if (fence[1].length !== FENCE_INDENT) {
          err(i + 1, `fence must be indented ${FENCE_INDENT} spaces to sit inside the bullet (found ${fence[1].length})`);
        }
        const body = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          if (FENCE_CLOSE.test(lines[j]) && !FENCE_OPEN.test(lines[j]) || /^\s*```\s*$/.test(lines[j])) break;
          body.push(lines[j].startsWith(' '.repeat(FENCE_INDENT)) ? lines[j].slice(FENCE_INDENT) : lines[j].trimStart());
        }
        if (j >= lines.length) {
          err(i + 1, 'fenced block is never closed');
        }
        const command = body.join('\n');
        if (/- \[ \]/.test(command)) err(i + 1, 'fenced block contains "- [ ]", which the sync engine would read as a checklist item');
        assign(block, blockName, label, command, i, err, item);
        i = j;
        continue;
      }
      assign(block, blockName, label, text, i, err, item);
      continue;
    }

    if (/^\s*```/.test(line)) {
      err(i, 'fenced block must directly follow a "Verify:" or "Fix:" label with no text');
      continue;
    }

    if (line.trim() === '') continue;

    // Any other indented line inside an item is a stray bullet or prose.
    if (/^\s*- /.test(line)) {
      err(i, `unexpected bullet inside item "${item.title}": ${line.trim().slice(0, 60)}`);
    }
  }

  // Completeness checks, only meaningful for structured guides.
  if (structured) {
    for (const it of items) {
      if (!it.console && !it.cli) err(it.line - 1, `item "${it.title}" has no Console or CLI block`);
      if (!it.pass) err(it.line - 1, `item "${it.title}" has no "- pass:" condition on its line`);
      if (it.console) {
        if (!it.console.verify) err(it.line - 1, `item "${it.title}": Console block has no Verify line`);
        if (!it.console.fix) err(it.line - 1, `item "${it.title}": Console block has no Fix line`);
      }
      if (it.cli) {
        if (it.cli.verify.length === 0) err(it.line - 1, `item "${it.title}": CLI block has no Verify line`);
        if (!it.cli.expect) err(it.line - 1, `item "${it.title}": CLI block has no Expect line`);
        if (it.cli.fix.length === 0) delete it.cli.fix;
      }
    }
  }

  for (const it of items) delete it.line;
  return { items, structured, errors };
}

function assign(block, blockName, label, value, i, err, item) {
  // An inline command is written as `...`; store the command itself.
  if (blockName === 'CLI' && label !== 'Expect' && /^`[^`]+`$/.test(value)) {
    value = value.slice(1, -1);
  }
  if (blockName === 'Console') {
    const key = label.toLowerCase();
    if (block[key]) err(i, `duplicate Console ${label} line in item "${item.title}"`);
    block[key] = value;
    return;
  }
  if (label === 'Expect') {
    if (block.expect) err(i, `duplicate Expect line in item "${item.title}" (exactly one allowed)`);
    block.expect = value;
    return;
  }
  block[label.toLowerCase()].push(value);
}

// -- Requirements ------------------------------------------------------------

function parseRequirements(content) {
  const requirements = [];
  const lines = content.split('\n');
  let currentSection = '';
  let current = null;
  let inRequirement = false;
  let bullets = [];
  let order = 0;

  const flush = () => {
    if (current && bullets.length > 0) {
      current.controlPoints = [...bullets];
      current.order = order++;
      requirements.push(current);
    }
    current = null;
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('### **') && line.endsWith('**')) {
      currentSection = line.replace(/### \*\*|\*\*/g, '');
      continue;
    }
    if (/^\*\*SP-[A-Z]+-\d+:/.test(line)) {
      flush();
      const m = line.match(/^\*\*(SP-[A-Z]+-\d+): ([^*]+)\*\*/);
      if (m) {
        current = { requirementId: m[1], title: m[2].trim(), section: currentSection };
        inRequirement = true;
      }
      continue;
    }
    if (inRequirement && line.startsWith('- ')) {
      bullets.push(line.substring(2).trim());
      continue;
    }
    if (inRequirement && (line === '' || line.startsWith('#'))) {
      flush();
      inRequirement = false;
    }
  }
  flush();
  return requirements;
}

function parseDomainFile(file) {
  const filename = path.basename(file);
  const m = filename.match(/^(\d{2})-([a-z0-9-]+)\.md$/);
  if (!m) return null;
  const content = fs.readFileSync(file, 'utf8');
  const h1 = content.match(/^#\s+(.+)$/m);
  let name = h1 ? h1[1].trim() : m[2];
  name = name.replace(/^Domain\s+\d+:\s*/, '');
  return {
    id: m[1],
    name,
    slug: m[2],
    order: parseInt(m[1], 10),
    requirements: parseRequirements(content),
  };
}

// -- Minimal JSON Schema check (the subset this repo's schema uses) ------------

function validateAgainstSchema(value, schema, root, where = '$') {
  const problems = [];
  const check = (v, s, p) => {
    if (s.$ref) {
      const ref = s.$ref.replace(/^#\//, '').split('/');
      let target = root;
      for (const seg of ref) target = target[seg];
      return check(v, target, p);
    }
    const t = s.type;
    const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (t) {
      const ok = t === 'integer' ? Number.isInteger(v) : actual === t;
      if (!ok) {
        problems.push(`${p}: expected ${t}, got ${actual}`);
        return;
      }
    }
    if (s.enum && !s.enum.includes(v)) problems.push(`${p}: "${v}" not in ${JSON.stringify(s.enum)}`);
    if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) problems.push(`${p}: "${v}" does not match ${s.pattern}`);
    if (s.minLength !== undefined && typeof v === 'string' && v.length < s.minLength) problems.push(`${p}: shorter than ${s.minLength}`);
    if (s.minimum !== undefined && typeof v === 'number' && v < s.minimum) problems.push(`${p}: below minimum ${s.minimum}`);
    if (actual === 'array') {
      if (s.minItems !== undefined && v.length < s.minItems) problems.push(`${p}: fewer than ${s.minItems} items`);
      if (s.items) v.forEach((x, i) => check(x, s.items, `${p}[${i}]`));
    }
    if (actual === 'object' && s.properties) {
      for (const r of s.required || []) if (!(r in v)) problems.push(`${p}: missing required "${r}"`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties[k]) check(x, s.properties[k], `${p}.${k}`);
        else if (s.additionalProperties === false) problems.push(`${p}: unexpected property "${k}"`);
      }
    }
  };
  check(value, schema, where);
  return problems;
}

module.exports = {
  getAllFiles,
  parseHtmlCommentMetadata,
  extractGuideTitle,
  determineCategory,
  extractGuideDescription,
  cleanChecklistItem,
  extractChecklistItems,
  parseGuideItems,
  parseRequirements,
  parseDomainFile,
  validateAgainstSchema,
};
