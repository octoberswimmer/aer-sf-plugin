import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { minimatch } from 'minimatch';

export type Replacement = {
	glob: string;
	stringToReplace?: string;
	regexToReplace?: string;
	replaceWithFile?: string;
	replaceWithEnv?: string;
};

export type PackageDirectory = { path: string };

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

function matchesGlob(glob: string, relPath: string): boolean {
	const normalized = relPath.split(sep).join('/');
	return minimatch(normalized, glob, { matchBase: true, dot: true });
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

	const fileValueCache = new Map<string, string>();
	const compiledReplacements = await Promise.all(
		replacements.map(async (r) => {
			let value: string;
			if (r.replaceWithFile) {
				const abs = resolve(projectRoot, r.replaceWithFile);
				if (!fileValueCache.has(abs)) {
					const content = await readFile(abs, 'utf8');
					// Match @salesforce/source-deploy-retrieve: trim a single trailing newline.
					const trimmed = content.endsWith('\r\n')
						? content.slice(0, -2)
						: content.endsWith('\n')
							? content.slice(0, -1)
							: content;
					fileValueCache.set(abs, trimmed);
				}
				value = fileValueCache.get(abs)!;
			} else if (r.replaceWithEnv) {
				const env = process.env[r.replaceWithEnv];
				if (env === undefined) {
					throw new Error(
						`sfdx-project.json replacement references missing environment variable: ${r.replaceWithEnv}`,
					);
				}
				value = env;
			} else {
				throw new Error(
					'sfdx-project.json replacement entry has neither replaceWithFile nor replaceWithEnv',
				);
			}
			return { ...r, value };
		}),
	);

	let fileCount = 0;
	for (const f of filesToStage) {
		const target = join(tempDir, f.relativeToProject);
		await mkdir(dirname(target), { recursive: true });

		const matching = compiledReplacements.filter((r) => matchesGlob(r.glob, f.relativeToProject));
		if (matching.length === 0) {
			const buf = await readFile(f.fullPath);
			await writeFile(target, buf);
		} else {
			let text = await readFile(f.fullPath, 'utf8');
			for (const r of matching) {
				if (r.stringToReplace !== undefined) {
					text = text.split(r.stringToReplace).join(r.value);
				} else if (r.regexToReplace !== undefined) {
					text = text.replace(new RegExp(r.regexToReplace, 'g'), r.value);
				}
			}
			await writeFile(target, text);
		}
		fileCount++;
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
