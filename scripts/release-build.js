#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const usage = () => {
  console.log(`LMDmapper release builder

Usage:
  npm run release:build -- --version <x.y.z> [--notes <file>] [--skip-lint] [--skip-build] [--dry-run]

Examples:
  npm run release:build -- --version 1.0.1 --notes release-notes/1.0.1.md
  npm run release:build -- --version 1.0.1 --skip-build
`);
};

const args = process.argv.slice(2);
const options = {
  version: '',
  notes: '',
  skipLint: false,
  skipBuild: false,
  dryRun: false
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  }
  if (arg === '--version') {
    options.version = args[index + 1] ?? '';
    index += 1;
    continue;
  }
  if (arg === '--notes') {
    options.notes = args[index + 1] ?? '';
    index += 1;
    continue;
  }
  if (arg === '--skip-lint') {
    options.skipLint = true;
    continue;
  }
  if (arg === '--skip-build') {
    options.skipBuild = true;
    continue;
  }
  if (arg === '--dry-run') {
    options.dryRun = true;
    continue;
  }
  throw new Error(`Unknown option: ${arg}`);
}

if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
  throw new Error('Expected --version <x.y.z>, e.g. --version 1.0.1');
}

const notesRelative = options.notes || path.join('release-notes', `${options.version}.md`);
const notesPath = path.resolve(ROOT, notesRelative);
if (!fs.existsSync(notesPath)) {
  const template = `- Summary of the release
- Key feature or fix 1
- Key feature or fix 2
`;
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  fs.writeFileSync(notesPath, template, 'utf8');
  throw new Error(
    `Release notes file was missing and has been created:\n  ${path.relative(
      ROOT,
      notesPath
    )}\nFill it and run again.`
  );
}

const run = (command, commandArgs) => {
  const rendered = [command, ...commandArgs].join(' ');
  console.log(`\n> ${rendered}`);
  if (options.dryRun) {
    return;
  }
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${rendered}`);
  }
};

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const write = (relativePath, content) =>
  fs.writeFileSync(path.join(ROOT, relativePath), content, 'utf8');

const replaceInFile = (relativePath, replacer) => {
  const current = read(relativePath);
  const next = replacer(current);
  if (next !== current && !options.dryRun) {
    write(relativePath, next);
  }
};

const normalizeNotesBody = (raw) => {
  const cleaned = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim();
  if (!cleaned) {
    throw new Error(`Release notes file is empty: ${path.relative(ROOT, notesPath)}`);
  }
  const lines = cleaned.split('\n').filter((line) => line.trim().length > 0);
  const hasBullets = lines.every((line) => /^[-*]\s+/.test(line.trim()));
  if (hasBullets) {
    return lines.join('\n');
  }
  return lines.map((line) => `- ${line.trim()}`).join('\n');
};

const getNextPatchVersion = (version) => {
  const [major, minor, patch] = version.split('.').map((value) => Number.parseInt(value, 10));
  return `${major}.${minor}.${patch + 1}`;
};

const updateChangelog = () => {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const notesBody = normalizeNotesBody(fs.readFileSync(notesPath, 'utf8'));
  const date = new Date().toISOString().slice(0, 10);
  const section = `## [${options.version}] - ${date}\n${notesBody}\n`;
  let changelog = fs.existsSync(changelogPath)
    ? fs.readFileSync(changelogPath, 'utf8')
    : `# Changelog\n\nAll notable changes to this project are documented in this file.\n\n## [Unreleased]\n\n`;

  if (changelog.includes(`## [${options.version}]`)) {
    return;
  }

  if (changelog.includes('## [Unreleased]')) {
    changelog = changelog.replace('## [Unreleased]', `## [Unreleased]\n\n${section}`);
  } else {
    changelog = `${changelog.trimEnd()}\n\n${section}`;
  }

  if (!options.dryRun) {
    fs.writeFileSync(changelogPath, changelog, 'utf8');
  }
};

const updateUnreleasedTarget = (targetVersion) => {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    return;
  }
  const current = fs.readFileSync(changelogPath, 'utf8');
  if (!current.includes('## [Unreleased]')) {
    return;
  }
  const next = current.replace(
    /## \[Unreleased\]\n(?:Target: [^\n]*\n)?(?:\n- Log all new changes here for the upcoming [^\n]+\n)?/,
    `## [Unreleased]\nTarget: ${targetVersion}\n\n- Log all new changes here for the upcoming ${targetVersion} release.\n`
  );
  if (!options.dryRun && next !== current) {
    fs.writeFileSync(changelogPath, next, 'utf8');
  }
};

const ensureNextReleaseNotes = (targetVersion) => {
  const targetPath = path.join(ROOT, 'release-notes', `${targetVersion}.md`);
  if (fs.existsSync(targetPath)) {
    return;
  }
  const template =
    '- Add change notes for this release as they are implemented.\n- Keep entries concise and user-facing.\n';
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, template, 'utf8');
  }
};

const hashFile = (relativePath) => {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return `${digest}  ${relativePath}`;
};

const writeChecksums = () => {
  const candidates = [
    `release/lmdmapper_${options.version}_arm64_mac.dmg`,
    `release/lmdmapper_${options.version}_arm64_mac.zip`,
    `release/lmdmapper_${options.version}_x64_win.exe`,
    `release/lmdmapper_${options.version}_x64_win.zip`
  ];
  const hashes = candidates.map(hashFile).filter(Boolean);
  if (!hashes.length) {
    return;
  }
  if (!options.dryRun) {
    fs.writeFileSync(
      path.join(ROOT, 'release', `SHA256SUMS-${options.version}.txt`),
      `${hashes.join('\n')}\n`,
      'utf8'
    );
  }
};

const syncVersionStrings = () => {
  const releaseDate = new Date().toISOString().slice(0, 10);
  replaceInFile('package.json', (content) =>
    content
      .replace(/"buildDate":\s*"[^"]*"/, `"buildDate": "${releaseDate}"`)
      .replace(
        /"description":\s*"LMDmapper - Leica \.lif spatial visualization tool \(v[^"]*\)"/,
        `"description": "LMDmapper - Leica .lif spatial visualization tool (v${options.version})"`
      )
  );
  replaceInFile('README.md', (content) =>
    content
      .replace(/^# LMDmapper \(v[^\)]+\)/m, `# LMDmapper (v${options.version})`)
      .replace(/^## Limitations \(v[^\)]+\)/m, `## Limitations (v${options.version})`)
      .replace(/Unsupported format \(v[^\)]+\)/g, `Unsupported format (v${options.version})`)
  );
  replaceInFile('src/renderer/App.tsx', (content) =>
    content.replace(/version:\s*'[^']*',/, `version: '${options.version}',`)
  );
};

const main = () => {
  const nextPatchVersion = getNextPatchVersion(options.version);
  run('npm', ['version', options.version, '--no-git-tag-version']);
  run('npm', ['install', '--package-lock-only']);
  syncVersionStrings();
  updateChangelog();
  updateUnreleasedTarget(nextPatchVersion);
  ensureNextReleaseNotes(nextPatchVersion);

  if (!options.skipLint) {
    run('npm', ['run', 'lint']);
  }

  if (!options.skipBuild) {
    run('npm', ['run', 'build']);
    run('npx', ['electron-builder', '--win', '--x64']);
    writeChecksums();
  }

  console.log('\nRelease preparation finished.');
  console.log(`Version: ${options.version}`);
  console.log(`Notes: ${path.relative(ROOT, notesPath)}`);
  console.log(`Next target: ${nextPatchVersion}`);
  if (!options.skipBuild) {
    console.log(`Checksums: release/SHA256SUMS-${options.version}.txt`);
  }
};

main();
