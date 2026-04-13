#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const { version } = require(path.join(root, 'package.json'));

const date = new Date().toISOString().slice(0, 10);

// Find the previous tag to scope git log
const tags = execSync('git tag -l "v*" --sort=-v:refname', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

// The current version tag (v0.1.12) won't exist yet when this runs inside
// `npm version`, so the first tag in the list is the previous release.
const prevTag = tags[0];

// Get commit messages since the previous tag, excluding merges and version bumps
const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
const log = execSync(
  `git log --oneline --no-merges ${range}`,
  { cwd: root, encoding: 'utf8' },
);

const skipPattern = /^[0-9a-f]+ (chore: bump version|release:|0\.\d+\.\d+$)/i;
const bullets = log
  .split('\n')
  .filter(Boolean)
  .filter(line => !skipPattern.test(line))
  .map(line => {
    // Strip the short hash prefix
    const msg = line.replace(/^[0-9a-f]+ /, '');
    // Strip conventional-commit prefixes (feat:, fix:, chore:, etc.)
    const cleaned = msg.replace(/^(feat|fix|chore|docs|refactor|style|test|ci|build|perf)(\(.+?\))?:\s*/i, '');
    return `- ${cleaned.charAt(0).toUpperCase() + cleaned.slice(1)}`;
  });

const section = bullets.length > 0 ? bullets.join('\n') : `- Release ${version}.`;
const entry = `\n## [${version}] - ${date}\n\n### Changed\n\n${section}\n`;

const content = fs.readFileSync(changelogPath, 'utf8');

// Find the first version section header (e.g. "## [1.2.3] - ..." or
// "## [Unreleased]") and insert the new entry immediately before it.
const versionHeaderPattern = /\n## \[/;
const match = versionHeaderPattern.exec(content);
const updated =
  match
    ? content.slice(0, match.index) + entry + content.slice(match.index)
    : content + entry;

fs.writeFileSync(changelogPath, updated);
