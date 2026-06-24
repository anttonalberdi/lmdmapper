#!/usr/bin/env node

/**
 * Regenerate the "Download" section of README.md from a published Zenodo record.
 *
 * Reads the record's actual file list from the Zenodo API and rewrites the block
 * between the <!-- BEGIN DOWNLOADS --> and <!-- END DOWNLOADS --> markers with
 * per-platform download links. Run automatically after a release is archived to
 * Zenodo, or manually:
 *
 *   node scripts/update-readme-downloads.js --recid 20827563
 *
 * Options:
 *   --recid <id>   (required) Zenodo record id of the version to link to.
 *   --version <x.y.z>  Optional display version (defaults to the record's).
 *   --dry-run      Print the generated section instead of writing the file.
 *
 * Environment:
 *   ZENODO_BASE    API/host. Default https://zenodo.org.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.ZENODO_BASE || 'https://zenodo.org').replace(/\/$/, '');
const BEGIN = '<!-- BEGIN DOWNLOADS -->';
const END = '<!-- END DOWNLOADS -->';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { recid: '', version: '', dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--recid') {
      options.recid = args[i + 1] ?? '';
      i += 1;
    } else if (arg === '--version') {
      options.version = args[i + 1] ?? '';
      i += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/update-readme-downloads.js --recid <id> [--version x.y.z] [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!/^\d+$/.test(options.recid)) {
    throw new Error('Expected --recid <numeric Zenodo record id>');
  }
  return options;
};

const repoUrl = () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const raw = (pkg.repository && pkg.repository.url) || '';
  return raw.replace(/^git\+/, '').replace(/\.git$/, '') || 'https://github.com/anttonalberdi/lmdmapper';
};

// Each row: an installer cell plus alternative-format cells. Matchers tolerate
// the different arch tokens electron-builder emits (x64/x86_64/amd64,
// arm64/aarch64) so links stay correct if naming drifts.
const ROWS = [
  { platform: 'macOS', arch: 'Apple Silicon (arm64)', installer: { label: '.dmg', re: /_arm64_mac\.dmg$/ }, others: [{ label: '.zip', re: /_arm64_mac\.zip$/ }] },
  { platform: 'macOS', arch: 'Intel (x64)', installer: { label: '.dmg', re: /_x64_mac\.dmg$/ }, others: [{ label: '.zip', re: /_x64_mac\.zip$/ }] },
  { platform: 'Windows', arch: 'x64', installer: { label: '.exe', re: /_x64_win\.exe$/ }, others: [{ label: '.zip', re: /_x64_win\.zip$/ }] },
  { platform: 'Windows', arch: 'arm64', installer: { label: '.exe', re: /_arm64_win\.exe$/ }, others: [{ label: '.zip', re: /_arm64_win\.zip$/ }] },
  { platform: 'Windows', arch: '32-bit (ia32)', installer: { label: '.exe', re: /_ia32_win\.exe$/ }, others: [{ label: '.zip', re: /_ia32_win\.zip$/ }] },
  {
    platform: 'Linux',
    arch: 'x64 (x86_64)',
    installer: { label: '.AppImage', re: /_(x86_64|x64|amd64)_linux\.AppImage$/ },
    others: [
      { label: '.deb', re: /_(amd64|x64|x86_64)_linux\.deb$/ },
      { label: '.rpm', re: /_(x86_64|x64|amd64)_linux\.rpm$/ },
      { label: '.tar.gz', re: /_(x64|x86_64|amd64)_linux\.tar\.gz$/ }
    ]
  },
  {
    platform: 'Linux',
    arch: 'arm64 (aarch64)',
    installer: { label: '.AppImage', re: /_(arm64|aarch64)_linux\.AppImage$/ },
    others: [
      { label: '.deb', re: /_(arm64|aarch64)_linux\.deb$/ },
      { label: '.rpm', re: /_(aarch64|arm64)_linux\.rpm$/ },
      { label: '.tar.gz', re: /_(arm64|aarch64)_linux\.tar\.gz$/ }
    ]
  }
];

const main = async () => {
  const options = parseArgs();
  const res = await fetch(`${BASE}/api/records/${options.recid}`);
  if (!res.ok) {
    throw new Error(`Zenodo GET /api/records/${options.recid} -> ${res.status} ${res.statusText}`);
  }
  const record = await res.json();
  const fileNames = (record.files || []).map((file) => file.key);
  if (!fileNames.length) {
    throw new Error(`Record ${options.recid} has no files`);
  }

  const recid = record.id;
  const version = options.version || record.metadata?.version || '';
  const versionDoi = record.doi;
  const conceptDoi = record.conceptdoi;
  const link = (name) => `${BASE}/records/${recid}/files/${name}?download=1`;
  const find = (re) => fileNames.find((name) => re.test(name));
  const cell = (spec) => {
    const name = find(spec.re);
    return name ? `[\`${spec.label}\`](${link(name)})` : '—';
  };

  const tableRows = ROWS.map((row) => {
    const installer = cell(row.installer);
    const others = row.others.map(cell).join(' · ');
    return `| ${row.platform} | ${row.arch} | ${installer} | ${others} |`;
  });

  const checksums = find(/^SHA256SUMS-.*\.txt$/);
  const checksumLine = checksums
    ? `Verify downloads against [\`${checksums}\`](${link(checksums)}).\n`
    : '';
  const allVersions = conceptDoi
    ? `[all-versions Zenodo record](https://doi.org/${conceptDoi})`
    : `[Zenodo](${BASE}/records/${recid})`;

  const block = [
    BEGIN,
    '## Download',
    '',
    `Pre-built installers for **v${version}** are archived on Zenodo`,
    `([DOI ${versionDoi}](https://doi.org/${versionDoi})). Pick the build for your`,
    'platform; the right-hand column lists alternative formats.',
    '',
    '| Platform | Architecture | Installer | Other formats |',
    '| --- | --- | --- | --- |',
    ...tableRows,
    '',
    `${checksumLine}For other releases, browse the ${allVersions} or the`,
    `[GitHub releases page](${repoUrl()}/releases).`,
    END
  ].join('\n');

  if (options.dryRun) {
    console.log(block);
    return;
  }

  const readmePath = path.join(ROOT, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  if (!readme.includes(BEGIN) || !readme.includes(END)) {
    throw new Error(`README.md is missing the ${BEGIN} / ${END} markers`);
  }
  const pattern = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  const next = readme.replace(pattern, block);
  if (next === readme) {
    console.log('README download section already up to date.');
    return;
  }
  fs.writeFileSync(readmePath, next, 'utf8');
  console.log(`Updated README download section to record ${recid} (v${version}).`);
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
