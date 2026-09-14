const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function getReleaseNotes(tag) {
	const version = tag.replace(/^v/, '');
	const readmePath = path.resolve(__dirname, '../README.md');
	if (!fs.existsSync(readmePath)) {
		console.warn('README.md not found.');
		return '';
	}
	const content = fs.readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n');

	// Extract version changelog from README.md
	const lines = content.split('\n');
	let capturing = false;
	const capturedLines = [];
	let previousVersion = null;

	for (const line of lines) {
		const match = line.match(/^###\s+(v?\d+\.\d+\.\d+(?:-\w+\.\d+)?)/i);
		if (match) {
			const foundVer = match[1].replace(/^v/, '');
			if (foundVer === version) {
				capturing = true;
			} else if (capturing) {
				previousVersion = foundVer;
				break;
			}
		} else if (capturing) {
			if (line.startsWith('## ') || line.startsWith('[Older changelog entries')) {
				break;
			}
			capturedLines.push(line);
		}
	}

	const changelogText = capturedLines.join('\n').trim();

	// Fetch GitHub PRs/contributors notes if gh is available and previousVersion is known
	let ghNotes = '';
	if (previousVersion) {
		try {
			const cmd = `gh api --method POST repos/meistermopper/ioBroker.harvia-fenix/releases/generate-notes -f tag_name="v${version}" -f previous_tag_name="v${previousVersion}" --jq .body`;
			ghNotes = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
		} catch {
			// Ignore if gh api is unavailable or fails
		}
	}

	let body = '';
	if (changelogText) {
		body += `### 📋 Changes\n\n${changelogText}\n\n`;
	}

	if (ghNotes) {
		const cleanGhNotes = ghNotes.replace(/\*\*Full Changelog\*\*:.*$/m, '').trim();
		if (cleanGhNotes) {
			body += `${cleanGhNotes}\n\n`;
		}
	}

	if (previousVersion) {
		body += `**Full Changelog**: https://github.com/meistermopper/ioBroker.harvia-fenix/compare/v${previousVersion}...v${version}\n`;
	}

	return body.trim();
}

function main() {
	const tag = process.argv[2];
	if (!tag) {
		console.error('Usage: node scripts/update-release-notes.js <tag>');
		process.exit(1);
	}

	console.log(`Generating release notes for tag: ${tag}`);
	const notes = getReleaseNotes(tag);
	if (!notes) {
		console.log('No release notes found or generated.');
		return;
	}

	console.log('Generated Release Notes:\n------------------------');
	console.log(notes);
	console.log('------------------------');

	const tmpFile = path.resolve(__dirname, '../release-notes.tmp.md');
	fs.writeFileSync(tmpFile, notes, 'utf8');

	try {
		execSync(`gh release edit "${tag}" --notes-file "${tmpFile}"`, { stdio: 'inherit' });
		console.log(`Successfully updated release notes on GitHub for ${tag}!`);
	} catch (err) {
		console.error(`Failed to update release notes via gh CLI: ${err.message}`);
	} finally {
		if (fs.existsSync(tmpFile)) {
			fs.unlinkSync(tmpFile);
		}
	}
}

if (require.main === module) {
	main();
}

module.exports = { getReleaseNotes };
