import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect } from 'chai';
import {
	_resetAerBinaryCache,
	defaultStorageDir,
	ensureAerBinary,
	platformDetails,
	readStoredVersion,
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
