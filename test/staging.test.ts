import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect } from 'chai';
import { stageSource } from '../src/staging.js';

async function makeProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'aer-stage-test-'));
}

async function writeFileEnsuringDir(file: string, content: string): Promise<void> {
	await mkdir(join(file, '..'), { recursive: true });
	await writeFile(file, content);
}

async function listRelative(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else out.push(relative(root, full).split(sep).join('/'));
		}
	}
	out.sort();
	return out;
}

describe('stageSource', () => {
	let project: string;

	beforeEach(async () => {
		project = await makeProject();
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it('dedups duplicate Apex class names — alphabetically-last full path wins', async () => {
		// force-app comes before submodules alphabetically; submodules wins.
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/MyClass.cls'),
			'public class MyClass { public static String tag() { return \'force-app\'; } }',
		);
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/MyClass.cls-meta.xml'),
			'<force-app/>',
		);
		await writeFileEnsuringDir(
			join(project, 'submodules/framework/framework/main/default/classes/MyClass.cls'),
			'public class MyClass { public static String tag() { return \'submodules\'; } }',
		);
		await writeFileEnsuringDir(
			join(project, 'submodules/framework/framework/main/default/classes/MyClass.cls-meta.xml'),
			'<submodules/>',
		);

		const staged = await stageSource({
			projectRoot: project,
			packageDirectories: [
				{ path: 'submodules/framework/framework' },
				{ path: 'force-app' },
			],
		});

		try {
			const files = await listRelative(staged.dir);
			// Only the submodules copy should remain.
			expect(files).to.deep.equal([
				'submodules/framework/framework/main/default/classes/MyClass.cls',
				'submodules/framework/framework/main/default/classes/MyClass.cls-meta.xml',
			]);
			const cls = await readFile(
				join(staged.dir, 'submodules/framework/framework/main/default/classes/MyClass.cls'),
				'utf8',
			);
			expect(cls).to.include('submodules');
		} finally {
			await staged.cleanup();
		}
	});

	it('dedups duplicate CustomMetadata records (.md-meta.xml) by basename', async () => {
		// Same record at two paths within one packageDirectory — sf project
		// deploy start would resolve to the alphabetically-last full path.
		await writeFileEnsuringDir(
			join(project, 'extra-tests/custom-field-mappings/customMetadata/MyType.SomeRecord.md-meta.xml'),
			'<from-custom-field-mappings/>',
		);
		await writeFileEnsuringDir(
			join(project, 'extra-tests/integration-tests/customMetadata/MyType.SomeRecord.md-meta.xml'),
			'<from-integration-tests/>',
		);

		const staged = await stageSource({
			projectRoot: project,
			packageDirectories: [{ path: 'extra-tests' }],
		});

		try {
			const files = await listRelative(staged.dir);
			expect(files).to.deep.equal([
				'extra-tests/integration-tests/customMetadata/MyType.SomeRecord.md-meta.xml',
			]);
			const content = await readFile(
				join(staged.dir, 'extra-tests/integration-tests/customMetadata/MyType.SomeRecord.md-meta.xml'),
				'utf8',
			);
			expect(content).to.include('integration-tests');
		} finally {
			await staged.cleanup();
		}
	});

	it('does not dedup folder-scoped types like .field-meta.xml across different parent objects', async () => {
		// Same field name on different objects must NOT collapse.
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/objects/Account/fields/IsEnabled__c.field-meta.xml'),
			'<account-field/>',
		);
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/objects/Contact/fields/IsEnabled__c.field-meta.xml'),
			'<contact-field/>',
		);

		const staged = await stageSource({
			projectRoot: project,
			packageDirectories: [{ path: 'force-app' }],
		});

		try {
			const files = await listRelative(staged.dir);
			expect(files).to.have.members([
				'force-app/main/default/objects/Account/fields/IsEnabled__c.field-meta.xml',
				'force-app/main/default/objects/Contact/fields/IsEnabled__c.field-meta.xml',
			]);
		} finally {
			await staged.cleanup();
		}
	});

	it('class-name dedup is case-insensitive', async () => {
		await writeFileEnsuringDir(
			join(project, 'a-pkg/main/default/classes/myclass.cls'),
			'public class myclass {}',
		);
		await writeFileEnsuringDir(
			join(project, 'b-pkg/main/default/classes/MyClass.cls'),
			'public class MyClass {}',
		);

		const staged = await stageSource({
			projectRoot: project,
			packageDirectories: [{ path: 'a-pkg' }, { path: 'b-pkg' }],
		});

		try {
			const files = await listRelative(staged.dir);
			expect(files).to.deep.equal(['b-pkg/main/default/classes/MyClass.cls']);
		} finally {
			await staged.cleanup();
		}
	});

	it('applies replacements from sfdx-project.json (replaceWithFile)', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/HasToken.cls'),
			"String value = '{NAMESPACE}';",
		);
		await writeFileEnsuringDir(join(project, 'config/namespace.txt'), 'ortoo_srv\n');

		const staged = await stageSource({
			projectRoot: project,
			packageDirectories: [{ path: 'force-app' }],
			replacements: [
				{
					glob: '*.*',
					stringToReplace: '{NAMESPACE}',
					replaceWithFile: 'config/namespace.txt',
				},
			],
		});

		try {
			const cls = await readFile(
				join(staged.dir, 'force-app/main/default/classes/HasToken.cls'),
				'utf8',
			);
			// Trailing newline in namespace.txt should be trimmed.
			expect(cls).to.equal("String value = 'ortoo_srv';");
		} finally {
			await staged.cleanup();
		}
	});

	it('applies replacements from sfdx-project.json (replaceWithEnv)', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/HasToken.cls'),
			"String build = '{BUILD_ID}';",
		);

		process.env.AER_TEST_BUILD_ID = 'build-42';
		try {
			const staged = await stageSource({
				projectRoot: project,
				packageDirectories: [{ path: 'force-app' }],
				replacements: [
					{
						glob: '**/*.cls',
						stringToReplace: '{BUILD_ID}',
						replaceWithEnv: 'AER_TEST_BUILD_ID',
					},
				],
			});

			try {
				const cls = await readFile(
					join(staged.dir, 'force-app/main/default/classes/HasToken.cls'),
					'utf8',
				);
				expect(cls).to.equal("String build = 'build-42';");
			} finally {
				await staged.cleanup();
			}
		} finally {
			delete process.env.AER_TEST_BUILD_ID;
		}
	});

	it('throws when replaceWithEnv refers to an unset variable', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/Anything.cls'),
			'public class Anything {}',
		);

		delete process.env.AER_TEST_DEFINITELY_UNSET;

		let threw = false;
		try {
			await stageSource({
				projectRoot: project,
				packageDirectories: [{ path: 'force-app' }],
				replacements: [
					{
						glob: '*.*',
						stringToReplace: '{X}',
						replaceWithEnv: 'AER_TEST_DEFINITELY_UNSET',
					},
				],
			});
		} catch (e) {
			threw = true;
			expect((e as Error).message).to.include('AER_TEST_DEFINITELY_UNSET');
		}
		expect(threw, 'expected stageSource to throw').to.equal(true);
	});

	it('regexToReplace performs a global regex replacement', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/Demo.cls'),
			'String a = "AAA"; String b = "AAB";',
		);

		const staged = await stageSource({
			projectRoot: project,
			packageDirectories: [{ path: 'force-app' }],
			replacements: [
				{
					glob: '**/*.cls',
					regexToReplace: 'A{3}',
					replaceWithEnv: 'PATH', // any defined env var
				},
			],
		});

		try {
			const cls = await readFile(
				join(staged.dir, 'force-app/main/default/classes/Demo.cls'),
				'utf8',
			);
			expect(cls).to.match(/String a = "[^"]+"; String b = "AAB";/);
			expect(cls).to.not.include('AAA');
		} finally {
			await staged.cleanup();
		}
	});
});
