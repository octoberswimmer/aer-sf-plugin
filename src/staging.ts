import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { minimatch } from 'minimatch';

export type ReplaceWhenEnv = { env: string; value: string | number | boolean };

export type Replacement = {
	glob?: string;
	filename?: string;
	stringToReplace?: string;
	regexToReplace?: string;
	replaceWithFile?: string;
	replaceWithEnv?: string;
	replaceWhenEnv?: ReplaceWhenEnv[];
	allowUnsetEnvVariable?: boolean;
};

export type ApexTestAccess = {
	permissionSets?: string[];
	permissionSetLicenses?: string[];
};

export type PackageDirectory = {
	path: string;
	unpackagedMetadata?: { path: string };
	apexTestAccess?: ApexTestAccess;
};

// Expand packageDirectories into the flat list of directories to stage,
// appending each entry's `unpackagedMetadata` path. Unpackaged metadata is not
// part of the package but must be available to compile and run tests against,
// so it is staged alongside the packaged source.
export function collectSourceDirectories(
	packageDirectories: PackageDirectory[],
): PackageDirectory[] {
	const dirs: PackageDirectory[] = [];
	for (const pd of packageDirectories) {
		dirs.push({ path: pd.path });
		if (pd.unpackagedMetadata?.path) {
			dirs.push({ path: pd.unpackagedMetadata.path });
		}
	}
	return dirs;
}

// Gather the permission sets named in every packageDirectory's `apexTestAccess`,
// deduped while preserving first-seen order. These map to aer's --assign-perms.
export function collectAssignPerms(packageDirectories: PackageDirectory[]): string[] {
	const seen = new Set<string>();
	const perms: string[] = [];
	for (const pd of packageDirectories) {
		for (const ps of pd.apexTestAccess?.permissionSets ?? []) {
			if (!seen.has(ps)) {
				seen.add(ps);
				perms.push(ps);
			}
		}
	}
	return perms;
}

// Gather the permission set licenses named in every packageDirectory's
// `apexTestAccess`, deduped while preserving first-seen order. aer has no
// equivalent for these, so the caller warns that they are ignored.
export function collectPermissionSetLicenses(packageDirectories: PackageDirectory[]): string[] {
	const seen = new Set<string>();
	const licenses: string[] = [];
	for (const pd of packageDirectories) {
		for (const psl of pd.apexTestAccess?.permissionSetLicenses ?? []) {
			if (!seen.has(psl)) {
				seen.add(psl);
				licenses.push(psl);
			}
		}
	}
	return licenses;
}

export type StagingResult = {
	dir: string;
	cleanup: () => Promise<void>;
	fileCount: number;
};

// Metadata file extensions whose basename uniquely identifies the component
// (i.e. the same basename in different packageDirectories is the same
// component and should be deduped). This excludes folder-scoped types like
// CustomField (`Foo__c.field-meta.xml` under `objects/<Obj>/fields/` — the
// field's identity is parent-object + name, not basename alone).
function getDedupableExtension(name: string): string | undefined {
	if (name.endsWith('.cls-meta.xml')) return '.cls-meta.xml';
	if (name.endsWith('.trigger-meta.xml')) return '.trigger-meta.xml';
	if (name.endsWith('.cls')) return '.cls';
	if (name.endsWith('.trigger')) return '.trigger';
	if (name.endsWith('.md-meta.xml')) return '.md-meta.xml';
	return undefined;
}

async function walk(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile()) {
				out.push(full);
			}
		}
	}
	return out;
}

const posixify = (p: string): string => p.split(sep).join('/');

// A replacement targets files by either `filename` (a project-relative path)
// or `glob`, matching the `sfdx-project.json` replacements schema. Paths are
// absolute here; `filename` is matched as a suffix (so a leading `/` in the
// config is tolerated) and `glob` is prefixed with `**/`, mirroring
// @salesforce/source-deploy-retrieve's `matchesFile`.
function matchesReplacement(r: Replacement, absPath: string): boolean {
	const p = posixify(absPath);
	return (
		(typeof r.filename === 'string' && p.endsWith(posixify(r.filename))) ||
		(typeof r.glob === 'string' && minimatch(p, `**/${r.glob}`))
	);
}

// A replacement is only applied when every `replaceWhenEnv` condition matches
// the current environment (values compared as strings), matching SDR's
// `envFilter`.
function envConditionsMet(r: Replacement): boolean {
	return (
		!r.replaceWhenEnv ||
		r.replaceWhenEnv.every((c) => process.env[c.env] === String(c.value))
	);
}

// Escape a literal search string so it can be used as a global regex, matching
// SDR's `stringToRegex`. Using regex replacement (rather than split/join) means
// `$`-substitutions in the replacement value behave as they do in the sf CLI.
function stringToRegex(input: string): RegExp {
	// eslint-disable-next-line no-useless-escape
	return new RegExp(input.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
}

// Files SDR treats as text (and therefore eligible for replacement). Known text
// extensions short-circuit; otherwise a NUL byte in the head marks it binary.
const textExtensions = new Set([
	'.cls',
	'.xml',
	'.json',
	'.js',
	'.css',
	'.html',
	'.htm',
	'.txt',
	'.md',
]);

function isTextFile(path: string, contents: Buffer): boolean {
	if (textExtensions.has(extname(path).toLowerCase())) {
		return true;
	}
	const len = Math.min(contents.length, 512);
	for (let i = 0; i < len; i++) {
		if (contents[i] === 0) {
			return false;
		}
	}
	return true;
}

export async function stageSource(opts: {
	projectRoot: string;
	packageDirectories: PackageDirectory[];
	replacements?: Replacement[];
}): Promise<StagingResult> {
	const { projectRoot, packageDirectories, replacements = [] } = opts;
	const tempDir = await mkdtemp(join(tmpdir(), 'aer-stage-'));

	type SourceFile = { fullPath: string; relativeToProject: string };
	const allFiles: SourceFile[] = [];
	for (const pd of packageDirectories) {
		const absPdRoot = resolve(projectRoot, pd.path);
		const files = await walk(absPdRoot);
		for (const f of files) {
			allFiles.push({
				fullPath: f,
				relativeToProject: relative(projectRoot, f),
			});
		}
	}

	// Sort by full path so the alphabetically-last entry wins on collision.
	allFiles.sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0));

	// Files whose basename uniquely identifies their metadata component
	// (Apex classes/triggers + CustomMetadata records) must be globally
	// unique. The alphabetically-last full path wins, matching
	// `sf project deploy start`.
	const dedupedByKey = new Map<string, SourceFile>();
	const passthrough: SourceFile[] = [];
	for (const f of allFiles) {
		const base = f.relativeToProject.split(sep).pop()!;
		if (getDedupableExtension(base)) {
			dedupedByKey.set(base.toLowerCase(), f);
		} else {
			passthrough.push(f);
		}
	}
	const filesToStage: SourceFile[] = [...dedupedByKey.values(), ...passthrough];

	// Drop replacements whose `replaceWhenEnv` conditions don't match the current
	// environment. This happens before resolving `replaceWithEnv` values, so a
	// filtered-out replacement with an unset variable never errors.
	const activeReplacements = replacements.filter(envConditionsMet);

	// Resolve a replacement's value lazily and cache it, so an unset variable
	// only errors when a file actually matches — mirroring SDR, which resolves
	// values while marking matched components.
	const fileValueCache = new Map<string, string>();
	const valueCache = new Map<Replacement, string>();
	const resolveValue = async (r: Replacement): Promise<string> => {
		const cached = valueCache.get(r);
		if (cached !== undefined) {
			return cached;
		}
		let value: string;
		if (typeof r.replaceWithEnv === 'string') {
			const env = process.env[r.replaceWithEnv];
			if (env === undefined) {
				if (r.allowUnsetEnvVariable) {
					value = '';
				} else {
					throw new Error(
						`"${r.replaceWithEnv}" is in sfdx-project.json as a value for "replaceWithEnv" property, but it's not set in your environment.`,
					);
				}
			} else {
				value = env;
			}
		} else if (typeof r.replaceWithFile === 'string') {
			const abs = resolve(projectRoot, r.replaceWithFile);
			if (!fileValueCache.has(abs)) {
				// Match @salesforce/source-deploy-retrieve: trim surrounding whitespace.
				fileValueCache.set(abs, (await readFile(abs, 'utf8')).trim());
			}
			value = fileValueCache.get(abs)!;
		} else {
			throw new Error(
				'sfdx-project.json replacement entry has neither replaceWithFile nor replaceWithEnv',
			);
		}
		valueCache.set(r, value);
		return value;
	};

	let fileCount = 0;
	try {
		for (const f of filesToStage) {
			const target = join(tempDir, f.relativeToProject);
			await mkdir(dirname(target), { recursive: true });

			const buf = await readFile(f.fullPath);
			const matching = activeReplacements.filter((r) => matchesReplacement(r, f.fullPath));
			// Binary files are copied untouched, matching SDR's text-file guard.
			if (matching.length === 0 || !isTextFile(f.fullPath, buf)) {
				await writeFile(target, buf);
			} else {
				let text = buf.toString('utf8');
				for (const r of matching) {
					// eslint-disable-next-line no-await-in-loop
					const value = await resolveValue(r);
					if (typeof r.stringToReplace === 'string') {
						text = text.replace(stringToRegex(r.stringToReplace), value);
					} else if (typeof r.regexToReplace === 'string') {
						text = text.replace(new RegExp(r.regexToReplace, 'g'), value);
					}
				}
				await writeFile(target, text);
			}
			fileCount++;
		}
	} catch (e) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		throw e;
	}

	const cleanup = async (): Promise<void> => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};

	const syncCleanup = (): void => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};
	process.once('exit', syncCleanup);
	process.once('SIGINT', () => {
		syncCleanup();
		process.exit(130);
	});
	process.once('SIGTERM', () => {
		syncCleanup();
		process.exit(143);
	});

	return { dir: tempDir, cleanup, fileCount };
}
