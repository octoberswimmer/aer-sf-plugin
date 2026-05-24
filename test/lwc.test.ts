import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { discoverLwcComponents } from '../src/lwc.js';

async function writeFileEnsuringDir(file: string, content: string): Promise<void> {
	await mkdir(join(file, '..'), { recursive: true });
	await writeFile(file, content);
}

describe('discoverLwcComponents', () => {
	let project: string;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), 'aer-lwc-test-'));
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it('should_find_lwc_components_with_meta_xml', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/helloWorld/helloWorld.js'),
			'export default class HelloWorld {}',
		);
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/helloWorld/helloWorld.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);

		const components = await discoverLwcComponents(project, [{ path: 'force-app' }]);
		expect(components).to.have.length(1);
		expect(components[0].name).to.equal('helloWorld');
	});

	it('should_skip_directories_without_meta_xml', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/noMeta/noMeta.js'),
			'export default class NoMeta {}',
		);

		const components = await discoverLwcComponents(project, [{ path: 'force-app' }]);
		expect(components).to.have.length(0);
	});

	it('should_skip_directories_starting_with_double_underscore', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/__tests__/__tests__.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);

		const components = await discoverLwcComponents(project, [{ path: 'force-app' }]);
		expect(components).to.have.length(0);
	});

	it('should_find_components_across_multiple_package_directories', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/compA/compA.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);
		await writeFileEnsuringDir(
			join(project, 'second-pkg/main/default/lwc/compB/compB.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);

		const components = await discoverLwcComponents(project, [
			{ path: 'force-app' },
			{ path: 'second-pkg' },
		]);
		expect(components).to.have.length(2);
		expect(components.map((c) => c.name)).to.deep.equal(['compA', 'compB']);
	});

	it('should_sort_components_alphabetically', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/zebra/zebra.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/alpha/alpha.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/middle/middle.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);

		const components = await discoverLwcComponents(project, [{ path: 'force-app' }]);
		expect(components.map((c) => c.name)).to.deep.equal(['alpha', 'middle', 'zebra']);
	});

	it('should_deduplicate_components_with_same_name_across_packages', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/lwc/shared/shared.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);
		await writeFileEnsuringDir(
			join(project, 'second-pkg/main/default/lwc/shared/shared.js-meta.xml'),
			'<LightningComponentBundle></LightningComponentBundle>',
		);

		const components = await discoverLwcComponents(project, [
			{ path: 'force-app' },
			{ path: 'second-pkg' },
		]);
		expect(components).to.have.length(1);
		expect(components[0].name).to.equal('shared');
	});

	it('should_return_empty_array_for_no_lwc_directories', async () => {
		await writeFileEnsuringDir(
			join(project, 'force-app/main/default/classes/Foo.cls'),
			'public class Foo {}',
		);

		const components = await discoverLwcComponents(project, [{ path: 'force-app' }]);
		expect(components).to.have.length(0);
	});

	it('should_handle_missing_package_directory', async () => {
		const components = await discoverLwcComponents(project, [{ path: 'nonexistent' }]);
		expect(components).to.have.length(0);
	});
});
