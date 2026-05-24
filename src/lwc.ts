import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type LwcComponent = {
	name: string;
	path: string;
};

export async function discoverLwcComponents(
	projectRoot: string,
	packageDirectories: { path: string }[],
): Promise<LwcComponent[]> {
	const seen = new Map<string, LwcComponent>();

	for (const pd of packageDirectories) {
		const absPdRoot = resolve(projectRoot, pd.path);
		const lwcDirs = await findLwcDirs(absPdRoot);
		for (const lwcDir of lwcDirs) {
			let entries;
			try {
				entries = await readdir(lwcDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const name = entry.name;
				if (name.startsWith('__')) continue;
				const componentDir = join(lwcDir, name);
				const hasMetaXml = await fileExists(join(componentDir, `${name}.js-meta.xml`));
				if (!hasMetaXml) continue;
				seen.set(name, { name, path: componentDir });
			}
		}
	}

	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function findLwcDirs(root: string): Promise<string[]> {
	const results: string[] = [];
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
			if (!entry.isDirectory()) continue;
			const full = join(dir, entry.name);
			if (entry.name === 'lwc') {
				results.push(full);
			} else {
				stack.push(full);
			}
		}
	}
	return results;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const s = await stat(filePath);
		return s.isFile();
	} catch {
		return false;
	}
}
