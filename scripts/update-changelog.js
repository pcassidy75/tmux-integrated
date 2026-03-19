#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const { version } = require(path.join(root, 'package.json'));

const date = new Date().toISOString().slice(0, 10);
// Placeholder entry — update the section type and bullet points with the
// actual changes before publishing.
const entry = `\n## [${version}] - ${date}\n\n### Changed\n\n- Release ${version}.\n`;

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
