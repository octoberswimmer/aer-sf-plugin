import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect } from 'chai';
import {
	_resetAerBinaryCache,
	checkForUpdate,
	defaultStorageDir,
	ensureAerBinary,
	platformDetails,
	readStoredVersion,
	recordPromptedVersion,
} from '../src/aerBinary.js';

const BINARY_NAME = process.platform === 'win32' ? 'aer.exe' : 'aer';

describe('ensureAerBinary', () => {
	let workdir: string;
	let storageDir: string;
	let savedEnv: { AER_BIN?: string; PATH?: string };

	beforeEach(async () => {
		workdir = await mkdtemp(join(tmpdir(), 'aer-bin-test-'));
		storageDir = join(workdir, 'storage');
		savedEnv = { AER_BIN: process.env.AER_BIN, PATH: process.env.PATH };
		_resetAerBinaryCache();
	});

	afterEach(async () => {
		_resetAerBinaryCache();
		process.env.AER_BIN = savedEnv.AER_BIN;
		process.env.PATH = savedEnv.PATH;
		await rm(workdir, { recursive: true, force: true });
	});

	async function makeFakeBinary(path: string): Promise<void> {
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, '#!/bin/sh\nexit 0\n');
		if (process.platform !== 'win32') {
			await chmod(path, 0o755);
		}
	}

	it('uses AER_BIN when it points to an executable', async () => {
		const customBin = join(workdir, 'custom', 'my-aer');
		await makeFakeBinary(customBin);
		process.env.AER_BIN = customBin;
		process.env.PATH = '';

		const resolved = await ensureAerBinary({ allowPrompt: false, storageDir });
		expect(resolved).to.equal(customBin);
	});

	it('falls through when AER_BIN is invalid', async () => {
		process.env.AER_BIN = join(workdir, 'does-not-exist');
		process.env.PATH = '';

		let warned = '';
		try {
			await ensureAerBinary({
				allowPrompt: false,
				storageDir,
				warn: (m) => {
					warned = m;
				},
			});
			expect.fail('expected ensureAerBinary to throw');
		} catch (err) {
			expect((err as Error).message).to.match(/Could not find the 'aer' binary/);
		}
		expect(warned).to.match(/AER_BIN/);
	});

	it('uses a previously downloaded binary in the storage dir', async () => {
		delete process.env.AER_BIN;
		process.env.PATH = '';
		const downloaded = join(storageDir, 'aer-bin', BINARY_NAME);
		await makeFakeBinary(downloaded);

		const resolved = await ensureAerBinary({ allowPrompt: false, storageDir });
		expect(resolved).to.equal(downloaded);
	});

	it('finds aer on PATH when no AER_BIN or downloaded copy exists', async () => {
		delete process.env.AER_BIN;
		const pathDir = join(workdir, 'pathdir');
		const onPath = join(pathDir, BINARY_NAME);
		await makeFakeBinary(onPath);
		process.env.PATH = pathDir + delimiter + (savedEnv.PATH ?? '').split(delimiter).filter((p) => !p.includes('aer')).join(delimiter);

		const resolved = await ensureAerBinary({ allowPrompt: false, storageDir });
		expect(resolved).to.equal(onPath);
	});

	it('throws (and does not prompt) when allowPrompt is false and no binary is available', async () => {
		delete process.env.AER_BIN;
		process.env.PATH = '';

		let confirmCalls = 0;
		try {
			await ensureAerBinary({
				allowPrompt: false,
				storageDir,
				confirm: async () => {
					confirmCalls += 1;
					return true;
				},
			});
			expect.fail('expected ensureAerBinary to throw');
		} catch (err) {
			expect((err as Error).message).to.match(/Could not find the 'aer' binary/);
		}
		expect(confirmCalls).to.equal(0);
	});

	it('throws when the user declines the download prompt', async () => {
		delete process.env.AER_BIN;
		process.env.PATH = '';

		let prompted = '';
		try {
			await ensureAerBinary({
				allowPrompt: true,
				storageDir,
				confirm: async (message) => {
					prompted = message;
					return false;
				},
			});
			expect.fail('expected ensureAerBinary to throw');
		} catch (err) {
			expect((err as Error).message).to.match(/aer is required but was not installed/);
		}
		expect(prompted).to.match(/Download/);
	});

	it('prefers AER_BIN over a downloaded copy and PATH', async () => {
		const customBin = join(workdir, 'custom', 'my-aer');
		await makeFakeBinary(customBin);
		const downloaded = join(storageDir, 'aer-bin', BINARY_NAME);
		await makeFakeBinary(downloaded);
		const pathDir = join(workdir, 'pathdir');
		await makeFakeBinary(join(pathDir, BINARY_NAME));
		process.env.AER_BIN = customBin;
		process.env.PATH = pathDir;

		const resolved = await ensureAerBinary({ allowPrompt: false, storageDir });
		expect(resolved).to.equal(customBin);
	});

	it('prefers the downloaded copy over PATH', async () => {
		delete process.env.AER_BIN;
		const downloaded = join(storageDir, 'aer-bin', BINARY_NAME);
		await makeFakeBinary(downloaded);
		const pathDir = join(workdir, 'pathdir');
		await makeFakeBinary(join(pathDir, BINARY_NAME));
		process.env.PATH = pathDir;

		const resolved = await ensureAerBinary({ allowPrompt: false, storageDir });
		expect(resolved).to.equal(downloaded);
	});
});

describe('platformDetails', () => {
	it('builds an archive name matching the aer-dist release scheme', () => {
		const details = platformDetails('v1.2.3');
		expect(details.archiveName).to.equal(`aer_${details.platformKey}_${details.cpuKey}_v1.2.3.zip`);
		expect(['amd64', 'arm64']).to.include(details.cpuKey);
		expect(['linux', 'darwin', 'windows']).to.include(details.platformKey);
		const expectedBinary = details.platformKey === 'windows' ? 'aer.exe' : 'aer';
		expect(details.binaryName).to.equal(expectedBinary);
	});
});

describe('defaultStorageDir', () => {
	it('produces a plugin-specific path under the user data area', () => {
		const dir = defaultStorageDir();
		expect(dir).to.include('aer-sf-plugin');
	});
});

describe('checkForUpdate', () => {
	let workdir: string;
	let storageDir: string;
	const aerPath = '/usr/local/bin/aer-fake';

	beforeEach(async () => {
		workdir = await mkdtemp(join(tmpdir(), 'aer-update-test-'));
		storageDir = join(workdir, 'storage');
	});

	afterEach(async () => {
		await rm(workdir, { recursive: true, force: true });
	});

	function withInstalled(version: string): { queryInstalled: (p: string) => Promise<string | null> } {
		return { queryInstalled: async () => version };
	}

	it('returns null when the binary cannot be queried', async () => {
		const result = await checkForUpdate({
			aerPath,
			storageDir,
			queryInstalled: async () => null,
			resolveLatest: async () => 'v9.9.9',
		});
		expect(result).to.equal(null);
	});

	it('returns PendingUpdate when latest differs from installed', async () => {
		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v1.1.0',
		});
		expect(result).to.deep.equal({ installed: 'v1.0.0', latest: 'v1.1.0' });
	});

	it('returns null when latest equals installed', async () => {
		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v1.0.0',
		});
		expect(result).to.equal(null);
	});

	it('compares versions case- and prefix-insensitively', async () => {
		const result = await checkForUpdate({
			aerPath,
			storageDir,
			queryInstalled: async () => '1.0.0-beta.5',
			resolveLatest: async () => 'v1.0.0-beta.5',
		});
		expect(result).to.equal(null);
	});

	it('persists lastCheck timestamp after a successful query', async () => {
		await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v1.0.0',
			now: () => 1700000000000,
		});

		const state = JSON.parse(await readFile(join(storageDir, 'update-check.json'), 'utf8'));
		expect(state.lastCheck).to.equal(1700000000000);
	});

	it('skips the network call when inside the rate-limit window', async () => {
		await mkdir(storageDir, { recursive: true });
		await writeFile(
			join(storageDir, 'update-check.json'),
			JSON.stringify({ lastCheck: 1700000000000 }),
			'utf8',
		);

		let calls = 0;
		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => {
				calls += 1;
				return 'v9.9.9';
			},
			now: () => 1700000000000 + 1000, // 1s later, well within 12h window
		});
		expect(result).to.equal(null);
		expect(calls).to.equal(0);
	});

	it('performs the check after the rate-limit window has elapsed', async () => {
		await mkdir(storageDir, { recursive: true });
		await writeFile(
			join(storageDir, 'update-check.json'),
			JSON.stringify({ lastCheck: 1700000000000 }),
			'utf8',
		);

		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v2.0.0',
			intervalMs: 1000,
			now: () => 1700000000000 + 2000,
		});
		expect(result).to.deep.equal({ installed: 'v1.0.0', latest: 'v2.0.0' });
	});

	it('honours force to bypass the rate-limit window', async () => {
		await mkdir(storageDir, { recursive: true });
		await writeFile(
			join(storageDir, 'update-check.json'),
			JSON.stringify({ lastCheck: 1700000000000 }),
			'utf8',
		);

		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v2.0.0',
			force: true,
			now: () => 1700000000000 + 1,
		});
		expect(result).to.deep.equal({ installed: 'v1.0.0', latest: 'v2.0.0' });
	});

	it('does not re-prompt for a version the user was already asked about', async () => {
		await recordPromptedVersion('v2.0.0', { storageDir });

		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v2.0.0',
			force: true,
		});
		expect(result).to.equal(null);
	});

	it('re-prompts when a newer version is published after a skip', async () => {
		await recordPromptedVersion('v2.0.0', { storageDir });

		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => 'v2.1.0',
			force: true,
		});
		expect(result).to.deep.equal({ installed: 'v1.0.0', latest: 'v2.1.0' });
	});

	it('swallows network errors and logs them', async () => {
		const logs: string[] = [];
		const result = await checkForUpdate({
			aerPath,
			storageDir,
			...withInstalled('v1.0.0'),
			resolveLatest: async () => {
				throw new Error('network exploded');
			},
			log: (m) => logs.push(m),
		});
		expect(result).to.equal(null);
		expect(logs.some((l) => l.includes('network exploded'))).to.equal(true);
	});
});

describe('replaceBinary', function () {
	// Exercises the atomic-rename install path used during a real download.
	// Skipped on Windows since the test rig isn't set up for it.
	if (process.platform === 'win32') {
		it.skip('skipped on Windows', () => {
			/* no-op */
		});
		return;
	}

	it('overwrites an existing aer binary in place', async () => {
		const { replaceBinary } = await loadInternals();
		const workdir = await mkdtemp(join(tmpdir(), 'aer-replace-test-'));
		try {
			const binDir = join(workdir, 'aer-bin');
			await mkdir(binDir, { recursive: true });
			const target = join(binDir, 'aer');

			await writeFile(target, 'old-binary-contents', { mode: 0o755 });

			await replaceBinary(binDir, 'aer', Buffer.from('new-binary-contents'), target);

			const written = await readFile(target, 'utf8');
			expect(written).to.equal('new-binary-contents');
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	});

	it('leaves no stray .new file behind after a successful install', async () => {
		const { replaceBinary } = await loadInternals();
		const workdir = await mkdtemp(join(tmpdir(), 'aer-replace-test-'));
		try {
			const binDir = join(workdir, 'aer-bin');
			await mkdir(binDir, { recursive: true });
			const target = join(binDir, 'aer');
			await writeFile(target, 'old');

			await replaceBinary(binDir, 'aer', Buffer.from('new'), target);

			let exists = true;
			try {
				await readFile(join(binDir, '.aer.new'));
			} catch {
				exists = false;
			}
			expect(exists).to.equal(false);
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	});

	it('creates the target when no previous binary exists', async () => {
		const { replaceBinary } = await loadInternals();
		const workdir = await mkdtemp(join(tmpdir(), 'aer-replace-test-'));
		try {
			const binDir = join(workdir, 'aer-bin');
			await mkdir(binDir, { recursive: true });
			const target = join(binDir, 'aer');

			await replaceBinary(binDir, 'aer', Buffer.from('first-install'), target);

			const written = await readFile(target, 'utf8');
			expect(written).to.equal('first-install');
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	});
});

async function loadInternals(): Promise<{ replaceBinary: (binDir: string, binaryName: string, data: Buffer, target: string) => Promise<void> }> {
	// replaceBinary is module-private; reach it via a TS-only import path.
	const mod = (await import('../src/aerBinary.js')) as unknown as {
		_internals?: { replaceBinary: (binDir: string, binaryName: string, data: Buffer, target: string) => Promise<void> };
	};
	if (!mod._internals) {
		throw new Error('replaceBinary internal not exposed; export _internals from aerBinary.ts for testing.');
	}
	return mod._internals;
}

describe('queryBinaryVersion', () => {
	let workdir: string;

	beforeEach(async () => {
		workdir = await mkdtemp(join(tmpdir(), 'aer-version-query-'));
	});

	afterEach(async () => {
		await rm(workdir, { recursive: true, force: true });
	});

	it('parses the version from a shell script that mimics aer --version', async () => {
		if (process.platform === 'win32') {
			return; // shell script trick is POSIX-only
		}
		const fakeBin = join(workdir, 'aer');
		await writeFile(fakeBin, '#!/bin/sh\necho "aer version v1.0.0-beta.5"\n');
		await chmod(fakeBin, 0o755);

		const { queryBinaryVersion } = await import('../src/aerBinary.js');
		const version = await queryBinaryVersion(fakeBin);
		expect(version).to.equal('v1.0.0-beta.5');
	});

	it('returns null when the binary errors out', async () => {
		if (process.platform === 'win32') return;
		const fakeBin = join(workdir, 'aer');
		await writeFile(fakeBin, '#!/bin/sh\nexit 1\n');
		await chmod(fakeBin, 0o755);

		const { queryBinaryVersion } = await import('../src/aerBinary.js');
		const version = await queryBinaryVersion(fakeBin);
		expect(version).to.equal(null);
	});

	it('returns null when the binary doesn\'t exist', async () => {
		const { queryBinaryVersion } = await import('../src/aerBinary.js');
		const version = await queryBinaryVersion(join(workdir, 'nope'));
		expect(version).to.equal(null);
	});
});

describe('recordPromptedVersion', () => {
	let workdir: string;
	let storageDir: string;

	beforeEach(async () => {
		workdir = await mkdtemp(join(tmpdir(), 'aer-record-test-'));
		storageDir = join(workdir, 'storage');
	});

	afterEach(async () => {
		await rm(workdir, { recursive: true, force: true });
	});

	it('writes lastPromptVersion while preserving lastCheck', async () => {
		await mkdir(storageDir, { recursive: true });
		await writeFile(
			join(storageDir, 'update-check.json'),
			JSON.stringify({ lastCheck: 1700000000000 }),
			'utf8',
		);
		await recordPromptedVersion('v3.2.1', { storageDir });

		const state = JSON.parse(await readFile(join(storageDir, 'update-check.json'), 'utf8'));
		expect(state.lastCheck).to.equal(1700000000000);
		expect(state.lastPromptVersion).to.equal('v3.2.1');
	});
});

describe('readStoredVersion', () => {
	let workdir: string;

	beforeEach(async () => {
		workdir = await mkdtemp(join(tmpdir(), 'aer-version-test-'));
	});

	afterEach(async () => {
		await rm(workdir, { recursive: true, force: true });
	});

	it('returns null when no VERSION file exists', async () => {
		expect(await readStoredVersion(workdir)).to.equal(null);
	});

	it('returns the trimmed VERSION file contents when present', async () => {
		const binDir = join(workdir, 'aer-bin');
		await mkdir(binDir, { recursive: true });
		await writeFile(join(binDir, 'VERSION'), 'v0.0.42\n', 'utf8');
		expect(await readStoredVersion(workdir)).to.equal('v0.0.42');
	});
});
