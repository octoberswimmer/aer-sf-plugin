import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { get as httpsGet } from 'node:https';
import AdmZip from 'adm-zip';

const REPO = 'octoberswimmer/aer-dist';
const BINARY_NAME = process.platform === 'win32' ? 'aer.exe' : 'aer';
const VERSION_FILE = 'VERSION';
const PLUGIN_DIR_NAME = 'aer-sf-plugin';
const BIN_SUBDIR = 'aer-bin';

export type ConfirmFn = (message: string) => Promise<boolean>;
export type LogFn = (message: string) => void;

export type EnsureAerOptions = {
	/** When false, never prompt — throw if binary cannot be resolved. Defaults to true. */
	allowPrompt?: boolean;
	/** Prompt callback for yes/no confirmation. Required when allowPrompt is true. */
	confirm?: ConfirmFn;
	/** Informational log callback. */
	log?: LogFn;
	/** Warning log callback. */
	warn?: LogFn;
	/** Override the storage directory (for testing). */
	storageDir?: string;
};

let cachedAerPath: string | null = null;
let resolving: Promise<string> | null = null;

/**
 * Resolve the aer binary path. Resolution order:
 *   1. AER_BIN env var (must be executable).
 *   2. Previously downloaded copy in the plugin's storage dir.
 *   3. `aer` on PATH.
 *   4. Prompt to download the latest release into the plugin's storage dir.
 */
export async function ensureAerBinary(opts: EnsureAerOptions = {}): Promise<string> {
	if (resolving) {
		return resolving;
	}

	const log = opts.log ?? (() => {});
	const warn = opts.warn ?? (() => {});
	const allowPrompt = opts.allowPrompt ?? true;
	const storageDir = opts.storageDir ?? defaultStorageDir();

	resolving = (async () => {
		const envBin = process.env.AER_BIN;
		if (envBin) {
			const resolved = await resolveExecutable(envBin);
			if (resolved) {
				cachedAerPath = resolved;
				return resolved;
			}
			warn(`AER_BIN is set to "${envBin}" but the file was not found or is not executable; falling back.`);
		}

		const downloaded = join(storageDir, BIN_SUBDIR, BINARY_NAME);
		if (await isExecutable(downloaded)) {
			cachedAerPath = downloaded;
			return downloaded;
		}

		const fromPath = await resolveExecutable('aer');
		if (fromPath) {
			cachedAerPath = fromPath;
			return fromPath;
		}

		if (cachedAerPath && (await isExecutable(cachedAerPath))) {
			return cachedAerPath;
		}

		if (!allowPrompt || !opts.confirm) {
			throw new Error(
				`Could not find the 'aer' binary. Install aer from https://github.com/${REPO}, set AER_BIN to its absolute path, or rerun interactively to download it automatically.`,
			);
		}

		const yes = await opts.confirm("aer was not found on PATH. Download the latest release from GitHub?");
		if (!yes) {
			throw new Error(`aer is required but was not installed.`);
		}

		const binPath = await downloadLatest(storageDir, log);
		cachedAerPath = binPath;
		return binPath;
	})().finally(() => {
		resolving = null;
	});

	return resolving;
}

/** For tests: forget any cached binary path so the next call re-resolves. */
export function _resetAerBinaryCache(): void {
	cachedAerPath = null;
	resolving = null;
}

/**
 * Default storage directory for binaries downloaded by this plugin. Mirrors the
 * conventions used by `envPaths` / oclif: respects XDG on Linux, Library/Application
 * Support on macOS, and LOCALAPPDATA on Windows.
 */
export function defaultStorageDir(): string {
	const home = homedir();
	switch (process.platform) {
		case 'win32': {
			const base = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
			return join(base, PLUGIN_DIR_NAME);
		}
		case 'darwin':
			return join(home, 'Library', 'Application Support', PLUGIN_DIR_NAME);
		default: {
			const base = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
			return join(base, PLUGIN_DIR_NAME);
		}
	}
}

async function downloadLatest(storageDir: string, log: LogFn): Promise<string> {
	const version = await resolveLatestVersion();
	log(`Downloading aer ${version}…`);
	return downloadAndExtract(storageDir, version, log);
}

async function downloadAndExtract(storageDir: string, version: string, log: LogFn): Promise<string> {
	const { binaryName, archiveName } = platformDetails(version);
	const url = `https://github.com/${REPO}/releases/download/${version}/${archiveName}`;

	const binDir = join(storageDir, BIN_SUBDIR);
	await mkdir(binDir, { recursive: true, mode: 0o755 });

	const tempDir = await mkdtemp(join(tmpdir(), 'aer-download-'));
	const archivePath = join(tempDir, archiveName);

	try {
		log(`Fetching ${url}`);
		await downloadFile(url, archivePath);

		log(`Extracting ${binaryName}…`);
		const extractedPath = extractBinary(archivePath, binaryName, binDir);

		if (process.platform !== 'win32') {
			await chmod(extractedPath, 0o755);
		}

		await writeFile(join(binDir, VERSION_FILE), version, 'utf8');
		log(`Installed aer ${version} to ${extractedPath}`);
		return extractedPath;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export function platformDetails(version: string): {
	platformKey: 'linux' | 'darwin' | 'windows';
	cpuKey: 'amd64' | 'arm64';
	binaryName: string;
	archiveName: string;
} {
	const platformKey = normalizeOS();
	const cpuKey = normalizeArch();
	const binaryName = platformKey === 'windows' ? 'aer.exe' : 'aer';
	const archiveName = `aer_${platformKey}_${cpuKey}_${version}.zip`;
	return { platformKey, cpuKey, binaryName, archiveName };
}

function normalizeOS(): 'linux' | 'darwin' | 'windows' {
	switch (process.platform) {
		case 'linux':
			return 'linux';
		case 'darwin':
			return 'darwin';
		case 'win32':
			return 'windows';
		default:
			throw new Error(`Unsupported operating system: ${process.platform}`);
	}
}

function normalizeArch(): 'amd64' | 'arm64' {
	switch (process.arch) {
		case 'x64':
			return 'amd64';
		case 'arm64':
			return 'arm64';
		default:
			throw new Error(`Unsupported architecture: ${process.arch}`);
	}
}

export async function readStoredVersion(storageDir: string): Promise<string | null> {
	try {
		const contents = await readFile(join(storageDir, BIN_SUBDIR, VERSION_FILE), 'utf8');
		return contents.trim() || null;
	} catch {
		return null;
	}
}

async function resolveLatestVersion(): Promise<string> {
	const latest = await requestJson(`https://api.github.com/repos/${REPO}/releases/latest`);
	if (latest.statusCode === 404) {
		return latestFromList();
	}
	if (latest.statusCode >= 400) {
		throw new Error(`GitHub API returned ${latest.statusCode} while resolving latest aer release.`);
	}

	const tag = latest.body?.tag_name;
	if (!tag) {
		throw new Error('Latest aer release response is missing tag_name.');
	}
	return String(tag);
}

async function latestFromList(): Promise<string> {
	const res = await requestJson(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
	if (res.statusCode >= 400) {
		throw new Error(`GitHub API returned ${res.statusCode} while listing aer releases.`);
	}
	if (!Array.isArray(res.body)) {
		throw new Error('Unexpected response while listing aer releases.');
	}
	for (const rel of res.body) {
		if (!rel?.draft && rel?.tag_name) {
			return String(rel.tag_name);
		}
	}
	throw new Error('No published aer releases were found.');
}

async function resolveExecutable(cmd: string): Promise<string | null> {
	if (cmd.includes('/') || cmd.includes('\\')) {
		const candidate = resolve(cmd);
		return (await isExecutable(candidate)) ? candidate : null;
	}

	const pathVar = process.env.PATH ?? '';
	const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
	for (const segment of pathVar.split(delimiter)) {
		if (!segment) continue;
		for (const ext of extensions) {
			const candidate = join(segment, cmd + ext);
			if (await isExecutable(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		const stats = await stat(filePath);
		if (!stats.isFile()) return false;
		if (process.platform === 'win32') return true;
		await access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function extractBinary(archivePath: string, binaryName: string, destDir: string): string {
	const zip = new AdmZip(archivePath);
	const entry = zip
		.getEntries()
		.find((e) => !e.isDirectory && e.entryName.replace(/\/$/, '').endsWith(binaryName));
	if (!entry) {
		throw new Error(`${binaryName} was not found inside the downloaded archive.`);
	}
	zip.extractEntryTo(entry, destDir, false, true);
	return join(destDir, binaryName);
}

async function requestJson(url: string): Promise<{ statusCode: number; body: any }> {
	const res = await httpRequest(url);
	try {
		return { statusCode: res.statusCode, body: JSON.parse(res.text) };
	} catch {
		return { statusCode: res.statusCode, body: null };
	}
}

async function downloadFile(url: string, dest: string): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const file = createWriteStream(dest);
		const handle = (currentUrl: string, redirects: number): void => {
			const req = httpsGet(currentUrl, { headers: requestHeaders() }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					if (redirects > 5) {
						rejectPromise(new Error('Too many redirects while downloading aer.'));
						return;
					}
					res.resume();
					req.destroy();
					handle(res.headers.location, redirects + 1);
					return;
				}
				if (!res.statusCode || res.statusCode >= 400) {
					file.close();
					rejectPromise(new Error(`Failed to download aer (HTTP ${res.statusCode ?? 'unknown'}).`));
					return;
				}

				res.pipe(file);
				res.on('error', (err) => {
					file.close();
					rejectPromise(err);
				});
				file.on('finish', () =>
					file.close((err) => (err ? rejectPromise(err) : resolvePromise())),
				);
				file.on('error', rejectPromise);
			});
			req.on('error', (err) => {
				file.close();
				rejectPromise(err);
			});
		};
		handle(url, 0);
	});
}

async function httpRequest(url: string): Promise<{ statusCode: number; text: string }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const req = httpsGet(url, { headers: requestHeaders() }, (res) => {
			let data = '';
			res.on('data', (chunk) => {
				data += chunk;
			});
			res.on('end', () => {
				resolvePromise({ statusCode: res.statusCode ?? 0, text: data });
			});
		});
		req.on('error', rejectPromise);
	});
}

function requestHeaders(): Record<string, string> {
	return {
		'User-Agent': '@octoberswimmer/aer-sf-plugin',
		Accept: 'application/vnd.github+json',
	};
}
