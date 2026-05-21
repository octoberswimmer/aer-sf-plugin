import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { get as httpsGet } from 'node:https';
import AdmZip from 'adm-zip';

const REPO = 'octoberswimmer/aer-dist';
const BINARY_NAME = process.platform === 'win32' ? 'aer.exe' : 'aer';
const VERSION_FILE = 'VERSION';
const PLUGIN_DIR_NAME = 'aer-sf-plugin';
const BIN_SUBDIR = 'aer-bin';
const UPDATE_STATE_FILE = 'update-check.json';
const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 12; // 12 hours

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

/** Module-private internals exposed for tests only. Not part of the public API. */
export const _internals = {
	get replaceBinary() {
		return replaceBinary;
	},
};

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
		const data = readBinaryFromArchive(archivePath, binaryName);

		const target = join(binDir, binaryName);
		await replaceBinary(binDir, binaryName, data, target);

		await writeFile(join(binDir, VERSION_FILE), version, 'utf8');
		return target;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Install a new binary at `target`, using the same atomic-rename strategy as
 * `aer upgrade` so that an in-use executable (notably on Windows) doesn't
 * cause the install to fail.
 *
 * Unix: write to `.{name}.new`, then rename over the target — atomic.
 * Windows: write to `.{name}.new`, rename existing target to `.{name}.old`,
 *          rename `.{name}.new` into place, then best-effort delete `.old`
 *          (which may stay around briefly if the file is still held open).
 */
async function replaceBinary(binDir: string, binaryName: string, data: Buffer, target: string): Promise<void> {
	const newPath = join(binDir, `.${binaryName}.new`);
	const oldPath = join(binDir, `.${binaryName}.old`);

	await rm(newPath, { force: true });
	await writeFile(newPath, data, { mode: 0o755 });
	if (process.platform !== 'win32') {
		// writeFile honors `mode` only on file creation; chmod explicitly so
		// a leftover `.new` from a prior failed install still ends up +x.
		await chmod(newPath, 0o755);
	}

	if (process.platform === 'win32') {
		await rm(oldPath, { force: true });

		const targetExists = await pathExists(target);
		if (targetExists) {
			try {
				await rename(target, oldPath);
			} catch (err) {
				await rm(newPath, { force: true }).catch(() => {});
				throw new Error(`Failed to move current aer executable aside: ${(err as Error).message}`);
			}
		}

		try {
			await rename(newPath, target);
		} catch (err) {
			if (targetExists) {
				await rename(oldPath, target).catch(() => {});
			}
			throw new Error(`Failed to move new aer executable into place: ${(err as Error).message}`);
		}

		// Best-effort cleanup; on Windows this may fail if the binary is
		// still mapped into a running process. The leftover .old file will
		// be removed by the next install.
		await rm(oldPath, { force: true }).catch(() => {});
	} else {
		// rename(2) on Unix atomically replaces the target.
		await rename(newPath, target);
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
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

export type UpdateState = {
	lastCheck?: number;
	lastPromptVersion?: string;
};

export type PendingUpdate = {
	installed: string;
	latest: string;
};

export type UpdateCheckOptions = {
	/** Absolute path to the aer binary to query for its --version. */
	aerPath: string;
	storageDir?: string;
	log?: LogFn;
	/** Override the rate-limit interval in ms (default 12h). Useful in tests. */
	intervalMs?: number;
	/** When true, ignore the rate-limit and always perform the GitHub query. */
	force?: boolean;
	/** Inject a clock for testing. */
	now?: () => number;
	/** Override the latest-version resolver (for testing). */
	resolveLatest?: () => Promise<string>;
	/** Override the installed-version resolver (for testing). */
	queryInstalled?: (binaryPath: string) => Promise<string | null>;
};

/**
 * Begin a background check for a newer aer release. Resolves with details about
 * an available update, or null when no upgrade is needed for any of the following
 * reasons: the rate-limit window hasn't elapsed since the last check, the binary
 * couldn't be queried for its version, the latest tag matches what's installed,
 * the user was already prompted for this version, or the network call failed
 * (logged but not re-thrown).
 *
 * The installed version is read by running `<aerPath> --version` rather than
 * trusting any cached VERSION file — that way the check survives upgrades
 * performed outside the plugin (e.g. by `aer upgrade`) and also works for users
 * who installed aer themselves on PATH.
 *
 * The lastCheck timestamp is persisted as soon as the GitHub query runs, so
 * we don't query repeatedly even if no update is found. The lastPromptVersion
 * is NOT persisted here — callers must invoke `recordPromptedVersion` once
 * they've actually surfaced the prompt to the user.
 */
export async function checkForUpdate(opts: UpdateCheckOptions): Promise<PendingUpdate | null> {
	const storageDir = opts.storageDir ?? defaultStorageDir();
	const log = opts.log ?? (() => {});
	const intervalMs = opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
	const now = opts.now?.() ?? Date.now();

	const state = await readUpdateState(storageDir);
	if (!opts.force && state.lastCheck && now - state.lastCheck < intervalMs) {
		return null;
	}

	const queryFn = opts.queryInstalled ?? queryBinaryVersion;
	const installed = await queryFn(opts.aerPath);
	if (!installed) {
		log(`aer update check skipped: could not determine installed version from ${opts.aerPath}`);
		return null;
	}

	const resolver = opts.resolveLatest ?? resolveLatestVersion;
	let latest: string;
	try {
		latest = await resolver();
	} catch (err) {
		log(`aer update check failed: ${(err as Error).message}`);
		return null;
	}

	await writeUpdateState(storageDir, { ...state, lastCheck: now });

	if (!latest || normalizeVersion(latest) === normalizeVersion(installed)) {
		return null;
	}

	if (state.lastPromptVersion && normalizeVersion(state.lastPromptVersion) === normalizeVersion(latest)) {
		return null;
	}

	return { installed, latest };
}

function normalizeVersion(v: string): string {
	const trimmed = v.trim();
	return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

/**
 * Run the given aer binary with `--version` and parse the reported version.
 * Returns null if the binary doesn't run, doesn't print recognizable output,
 * or takes too long.
 */
export async function queryBinaryVersion(binaryPath: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			resolvePromise(result);
		};

		let child;
		try {
			child = spawn(binaryPath, ['--version'], {
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, AER_AUTOUPDATE_DISABLED: '1' },
			});
		} catch {
			finish(null);
			return;
		}

		const timer = setTimeout(() => {
			child.kill();
			finish(null);
		}, 5000);

		child.stdout?.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', () => {
			clearTimeout(timer);
			finish(null);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				finish(null);
				return;
			}
			const output = stdout || stderr;
			// Match strings like "v1.0.0-beta.5" or "1.0.0".
			const match = output.match(/v?\d+\.\d+\.\d+(?:[\w.-]+)?/);
			if (!match) {
				finish(null);
				return;
			}
			const raw = match[0];
			finish(raw.startsWith('v') ? raw : `v${raw}`);
		});
	});
}

/**
 * Persist that the user has been prompted about a version, so subsequent
 * commands don't repeat the prompt for that same version.
 */
export async function recordPromptedVersion(version: string, opts: { storageDir?: string } = {}): Promise<void> {
	const storageDir = opts.storageDir ?? defaultStorageDir();
	const state = await readUpdateState(storageDir);
	await writeUpdateState(storageDir, { ...state, lastPromptVersion: version });
}

/** Download and install a specific aer version into the plugin's storage dir. */
export async function installAerVersion(
	version: string,
	opts: { storageDir?: string; log?: LogFn } = {},
): Promise<string> {
	const storageDir = opts.storageDir ?? defaultStorageDir();
	const log = opts.log ?? (() => {});
	const newPath = await downloadAndExtract(storageDir, version, log);
	cachedAerPath = newPath;
	return newPath;
}

async function readUpdateState(storageDir: string): Promise<UpdateState> {
	try {
		const contents = await readFile(join(storageDir, UPDATE_STATE_FILE), 'utf8');
		const parsed = JSON.parse(contents);
		if (parsed && typeof parsed === 'object') {
			return parsed as UpdateState;
		}
	} catch {
		// Missing or corrupt state — treat as empty.
	}
	return {};
}

async function writeUpdateState(storageDir: string, state: UpdateState): Promise<void> {
	await mkdir(storageDir, { recursive: true });
	await writeFile(join(storageDir, UPDATE_STATE_FILE), JSON.stringify(state), 'utf8');
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

function readBinaryFromArchive(archivePath: string, binaryName: string): Buffer {
	const zip = new AdmZip(archivePath);
	const entry = zip
		.getEntries()
		.find((e) => !e.isDirectory && e.entryName.replace(/\/$/, '').endsWith(binaryName));
	if (!entry) {
		throw new Error(`${binaryName} was not found inside the downloaded archive.`);
	}
	return entry.getData();
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
