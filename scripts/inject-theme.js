/**
 * 批量给所有页面注入主题支持
 * 用法: node scripts/inject-theme.js
 */
const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '..', 'miniprogram', 'pages');

// 已经接入主题的页面，跳过
const SKIP = new Set([
  'settings', 'messages', 'moments', 'trip-detail', 'trip-votes',
  'profile', 'index', 'ai-assistant', 'ai-search'
]);

function getAllPageDirs() {
  const entries = fs.readdirSync(PAGES_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

function processJs(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // 1. Add require after last existing require, before Page({
  if (!content.includes("require('../../utils/theme')")) {
    const lines = content.split('\n');
    let lastRequireIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(const|let|var)\s+\w+\s*=\s*require\(/.test(lines[i])) {
        lastRequireIdx = i;
      }
    }
    if (lastRequireIdx >= 0) {
      lines.splice(lastRequireIdx + 1, 0, "const theme = require('../../utils/theme');");
    } else {
      // No requires at all, add before Page({
      const pageIdx = lines.findIndex(l => /^\s*Page\(\s*\{/.test(l));
      if (pageIdx >= 0) {
        lines.splice(pageIdx, 0, "const theme = require('../../utils/theme');", '');
      }
    }
    content = lines.join('\n');
    modified = true;
  }

  // 2. Add themeStyle/themeClass to data object (after 'data: {')
  if (!content.includes('themeStyle:')) {
    content = content.replace(
      /(data:\s*\{)/,
      "$1\n    themeStyle: '',\n    themeClass: 'theme-blue',"
    );
    modified = true;
  }

  // 3. Add theme.applyToPage(this) in onShow (or add onShow if missing)
  if (!content.includes('theme.applyToPage(this)')) {
    if (content.includes('onShow')) {
      // Add as first line inside existing onShow
      content = content.replace(
        /(onShow\s*\(\s*\)\s*\{)/,
        "$1\n    theme.applyToPage(this);"
      );
    } else {
      // No onShow - add one after onLoad if exists, or before first custom method
      if (content.includes('onLoad')) {
        // Find the closing } of onLoad and add onShow after it
        content = content.replace(
          /(onLoad\s*\([^)]*\)\s*\{[^}]*\})/s,
          "$1\n\n  onShow() {\n    theme.applyToPage(this);\n  },"
        );
      } else {
        // Neither onLoad nor onShow - add onShow at start of methods
        content = content.replace(
          /(Page\(\{\s*\n\s*data:\s*\{[^}]*\},)/s,
          "$1\n\n  onShow() {\n    theme.applyToPage(this);\n  },"
        );
      }
    }
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✓ ${path.basename(filePath)}`);
  } else {
    console.log(`  - ${path.basename(filePath)} (no changes)`);
  }
  return modified;
}

function processWxml(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // 1. Add page-meta if missing
  if (!content.includes('<page-meta')) {
    content = '<page-meta page-style="{{themeStyle}}"/>\n' + content;
    modified = true;
  }

  // 2. Add themeClass to root element if not present
  if (!content.includes('themeClass')) {
    // Find the first non-comment, non-page-meta element with a class
    // Match patterns like: class="xxx" or class='xxx'
    const rootClassMatch = content.match(/class="([^"]*)"/);
    if (rootClassMatch && !rootClassMatch[1].includes('themeClass')) {
      content = content.replace(
        /class="([^"]*)"/,
        'class="$1 {{themeClass}}"'
      );
      modified = true;
    } else if (content.match(/class='([^']*)'/)) {
      const match = content.match(/class='([^']*)'/);
      if (match && !match[1].includes('themeClass')) {
        content = content.replace(
          /class='([^']*)'/,
          "class='$1 {{themeClass}}'"
        );
        modified = true;
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✓ ${path.basename(filePath)}`);
  } else {
    console.log(`  - ${path.basename(filePath)} (no changes)`);
  }
  return modified;
}

function main() {
  const dirs = getAllPageDirs();
  console.log(`Found ${dirs.length} page directories\n`);

  let jsModified = 0, wxmlModified = 0, skipped = 0;

  for (const dir of dirs) {
    if (SKIP.has(dir)) {
      console.log(`◌ ${dir}/ (skipped - already has theme)`);
      skipped++;
      continue;
    }

    const jsPath = path.join(PAGES_DIR, dir, `${dir}.js`);
    const wxmlPath = path.join(PAGES_DIR, dir, `${dir}.wxml`);

    if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) {
      console.log(`✗ ${dir}/ (missing js or wxml)`);
      continue;
    }

    console.log(`▶ ${dir}/`);
    if (processJs(jsPath)) jsModified++;
    if (processWxml(wxmlPath)) wxmlModified++;
  }

  console.log(`\n---`);
  console.log(`Done: ${jsModified} JS files, ${wxmlModified} WXML files modified, ${skipped} skipped`);
}

main();
