#!/usr/bin/env node
/**
 * Adds a path comment at the top of every source file under src/.
 * Idempotent — running it twice won't duplicate the comment.
 *
 * Usage:
 *   node scripts/add-path-comments.js
 *   node scripts/add-path-comments.js --dry-run
 *   node scripts/add-path-comments.js --dir=src
 */

const fs = require('fs');
const path = require('path');

// ---------- Config ----------
const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dirArg = args.find(a => a.startsWith('--dir='));
const TARGET_DIR = path.resolve(ROOT, dirArg ? dirArg.split('=')[1] : 'src');

// Files we'll process, mapped to how we write the comment
const STYLE_BY_EXT = {
  '.js':    { open: '// ', close: '',     line: true },
  '.jsx':   { open: '// ', close: '',     line: true },
  '.ts':    { open: '// ', close: '',     line: true },
  '.tsx':   { open: '// ', close: '',     line: true },
  '.mjs':   { open: '// ', close: '',     line: true },
  '.cjs':   { open: '// ', close: '',     line: true },
  '.java':  { open: '// ', close: '',     line: true },
  '.swift': { open: '// ', close: '',     line: true },
  '.kt':    { open: '// ', close: '',     line: true },
  '.go':    { open: '// ', close: '',     line: true },
  '.rs':    { open: '// ', close: '',     line: true },
  '.c':     { open: '// ', close: '',     line: true },
  '.cpp':   { open: '// ', close: '',     line: true },
  '.h':     { open: '// ', close: '',     line: true },
  '.py':    { open: '# ',  close: '',     line: true },
  '.rb':    { open: '# ',  close: '',     line: true },
  '.sh':    { open: '# ',  close: '',     line: true },
  '.yml':   { open: '# ',  close: '',     line: true },
  '.yaml':  { open: '# ',  close: '',     line: true },
  '.css':   { open: '/* ', close: ' */',  line: false },
  '.scss':  { open: '/* ', close: ' */',  line: false },
  '.less':  { open: '/* ', close: ' */',  line: false },
  '.html':  { open: '<!-- ', close: ' -->', line: false },
  '.htm':   { open: '<!-- ', close: ' -->', line: false },
  '.md':    { open: '<!-- ', close: ' -->', line: false },
  '.svg':   { open: '<!-- ', close: ' -->', line: false },
};

// Directories to skip entirely
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.expo', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'android', 'ios', '.gradle', '.idea', '.vscode',
]);

// ---------- Helpers ----------
function makeComment(relPath, style) {
  const text = `path: ${relPath}`;
  return style.line
    ? `${style.open}${text}\n`
    : `${style.open}${text}${style.close}\n`;
}

function alreadyHasPathComment(content) {
  // Checks the first 3 lines for a path marker of any comment flavor
  const head = content.split('\n', 3).join('\n');
  return /(^|\n)\s*(\/\/|#|\/\*|<!--)\s*path:\s/.test(head);
}

function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}

// ---------- Main ----------
if (!fs.existsSync(TARGET_DIR)) {
  console.error(`Directory not found: ${TARGET_DIR}`);
  process.exit(1);
}

let processed = 0;
let skipped = 0;
const touched = [];

walk(TARGET_DIR, (file) => {
  const ext = path.extname(file).toLowerCase();
  const style = STYLE_BY_EXT[ext];
  if (!style) return;

  const relPath = path.relative(ROOT, file).split(path.sep).join('/');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  if (alreadyHasPathComment(content)) {
    skipped++;
    return;
  }

  // Preserve a shebang if present (node/shell scripts)
  const shebangMatch = content.match(/^#![^\n]*\n/);
  const shebang = shebangMatch ? shebangMatch[0] : '';
  const body = shebang ? content.slice(shebang.length) : content;

  const newContent = shebang + makeComment(relPath, style) + body;

  if (!DRY_RUN) {
    fs.writeFileSync(file, newContent, 'utf8');
  }
  processed++;
  touched.push(relPath);
});

// ---------- Report ----------
console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}Path comments`);
console.log(`  Target:   ${path.relative(ROOT, TARGET_DIR) || '.'}`);
console.log(`  Added:    ${processed}`);
console.log(`  Skipped:  ${skipped} (already tagged)`);
if (touched.length) {
  console.log('\nFiles touched:');
  touched.forEach(f => console.log(`  ${f}`));
}
console.log('');