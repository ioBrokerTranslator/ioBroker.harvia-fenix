const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function getPreviousTag(tag) {
	try {
		const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf8' })
			.trim()
			.split('\n')
			.map((t) => t.trim())
			.filter(Boolean);
		const idx = tags.indexOf(tag);
		if (idx !== -1 && idx + 1 < tags.length) {
			return tags[idx + 1];
		}
	} catch {
		// Ignore git errors
	}
	return null;
}

function extractVersionChangelog(version) {
	const readmePath = path.resolve(__dirname, '../README.md');
	const oldPath = path.resolve(__dirname, '../CHANGELOG_OLD.md');
	const ioPkgPath = path.resolve(__dirname, '../io-package.json');

	const filesToCheck = [readmePath, oldPath];
	for (const filePath of filesToCheck) {
		if (!fs.existsSync(filePath)) continue;
		const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
		const lines = content.split('\n');

		let capturing = false;
		const captured = [];
		for (const line of lines) {
			const match = line.match(/^#{2,3}\s+(?:v?(\d+\.\d+\.\d+(?:-[\w.]+)?))/i);
			if (match) {
				const foundVer = match[1];
				if (foundVer === version) {
					capturing = true;
				} else if (capturing) {
					break;
				}
			} else if (capturing) {
				if (line.match(/^#{1,3}\s+/) || line.startsWith('[Older changelog entries')) {
					break;
				}
				captured.push(line);
			}
		}

		const text = captured.join('\n').trim();
		if (text) {
			return text;
		}
	}

	// Fallback to io-package.json common.news
	if (fs.existsSync(ioPkgPath)) {
		try {
			const ioPkg = JSON.parse(fs.readFileSync(ioPkgPath, 'utf8'));
			const news = ioPkg.common?.news?.[version];
			if (news) {
				const rawNews = typeof news === 'string' ? news : news.en || Object.values(news)[0];
				if (rawNews) {
					return rawNews
						.split('\n')
						.map((l) => (l.trim().startsWith('*') ? l : `* ${l}`))
						.join('\n');
				}
			}
		} catch {
			// Ignore json parse errors
		}
	}

	return '';
}

function parseChangelogItems(rawText) {
	if (!rawText) return { breakingItems: [], regularItems: [] };

	const lines = rawText.split('\n');
	const items = [];
	let currentItem = null;

	for (const line of lines) {
		if (/^\s*[*+-]\s+/.test(line)) {
			if (currentItem) {
				items.push(currentItem);
			}
			currentItem = {
				lines: [line],
				isBreaking: /\b(breaking|breaking\s+change)\b/i.test(line),
			};
		} else if (currentItem) {
			currentItem.lines.push(line);
			if (/\b(breaking|breaking\s+change)\b/i.test(line)) {
				currentItem.isBreaking = true;
			}
		}
	}
	if (currentItem) {
		items.push(currentItem);
	}

	return {
		breakingItems: items.filter((it) => it.isBreaking),
		regularItems: items.filter((it) => !it.isBreaking),
	};
}

function getReleaseNotes(tag) {
	const version = tag.replace(/^v/, '');
	const previousTag = getPreviousTag(tag);

	const rawChangelog = extractVersionChangelog(version);
	const { breakingItems, regularItems } = parseChangelogItems(rawChangelog);

	// Fetch GitHub PR notes via gh API if available
	let ghNotes = '';
	if (previousTag) {
		try {
			const cmd = `gh api --method POST repos/meistermopper/ioBroker.harvia-fenix/releases/generate-notes -f tag_name="${tag}" -f previous_tag_name="${previousTag}" --jq .body`;
			ghNotes = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
		} catch {
			// Ignore if gh api is unavailable
		}
	}

	let body = '';

	// 1. Breaking Changes callout at the very top
	if (breakingItems.length > 0) {
		body += '> [!WARNING]\n> ### ⚠️ Breaking Changes\n>\n';
		for (const item of breakingItems) {
			for (const line of item.lines) {
				body += `> ${line}\n`;
			}
		}
		body += '\n';
	}

	// 2. Regular changes
	if (regularItems.length > 0) {
		body += '### 📋 Changes\n\n';
		for (const item of regularItems) {
			body += `${item.lines.join('\n')}\n`;
		}
		body += '\n';
	}

	// 3. GitHub PRs & dependencies
	if (ghNotes) {
		const cleanGhNotes = ghNotes.replace(/\*\*Full Changelog\*\*:.*$/m, '').trim();
		if (cleanGhNotes) {
			body += `${cleanGhNotes}\n\n`;
		}
	}

	// 4. Full Changelog compare link
	if (previousTag) {
		body += `**Full Changelog**: https://github.com/meistermopper/ioBroker.harvia-fenix/compare/${previousTag}...${tag}\n`;
	}

	return body.trim();
}

function updateRelease(tag, dryRun = false) {
	console.log(`Processing tag: ${tag}`);
	const notes = getReleaseNotes(tag);
	if (!notes) {
		console.log(`No release notes found for tag ${tag}.`);
		return;
	}

	if (dryRun) {
		console.log(`--- [DRY RUN] Generated Notes for ${tag} ---`);
		console.log(notes);
		console.log('---------------------------------------------');
		return;
	}

	const tmpFile = path.resolve(__dirname, `../release-notes-${tag.replace(/[^a-zA-Z0-9_-]/g, '_')}.tmp.md`);
	fs.writeFileSync(tmpFile, notes, 'utf8');

	try {
		execSync(`gh release edit "${tag}" --notes-file "${tmpFile}"`, { stdio: 'inherit' });
		console.log(`✅ Successfully updated GitHub release for ${tag}!`);
	} catch (err) {
		console.error(`❌ Failed to update release ${tag}: ${err.message}`);
	} finally {
		if (fs.existsSync(tmpFile)) {
			fs.unlinkSync(tmpFile);
		}
	}
}

function getAllPublishedReleaseTags() {
	try {
		const output = execSync('gh release list --limit 100 --json tagName --jq ".[].tagName"', {
			encoding: 'utf8',
		});
		return output
			.trim()
			.split('\n')
			.map((t) => t.trim())
			.filter(Boolean);
	} catch (e) {
		console.error(`Could not list GitHub releases: ${e.message}`);
		return [];
	}
}

function main() {
	const args = process.argv.slice(2);
	const dryRun = args.includes('--dry-run');
	const tags = args.filter((a) => !a.startsWith('--'));

	if (args.includes('--all')) {
		const allTags = getAllPublishedReleaseTags();
		console.log(`Found ${allTags.length} published releases on GitHub.`);
		for (const tag of allTags) {
			updateRelease(tag, dryRun);
		}
		return;
	}

	if (tags.length === 0) {
		console.error('Usage:');
		console.error('  node scripts/update-release-notes.js <tag> [<tag2> ...]');
		console.error('  node scripts/update-release-notes.js --all');
		console.error('  node scripts/update-release-notes.js --dry-run <tag>');
		process.exit(1);
	}

	for (const tag of tags) {
		updateRelease(tag, dryRun);
	}
}

if (require.main === module) {
	main();
}

module.exports = { getReleaseNotes, parseChangelogItems, extractVersionChangelog };
