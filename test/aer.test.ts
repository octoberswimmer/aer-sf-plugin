import { expect } from 'chai';
import { buildAerArgs, buildServerArgs } from '../src/aer.js';

describe('buildAerArgs', () => {
	it('starts with test <stagedDir>', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
		});
		expect(args.slice(0, 2)).to.deep.equal(['test', '/tmp/stage']);
	});

	it('passes each filter via --filter', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: ['MyClassTest.*', 'OtherTest.testFoo'],
			resultFormat: 'human',
			verbose: false,
		});
		expect(args).to.deep.equal([
			'test',
			'/tmp/stage',
			'--filter',
			'MyClassTest.*',
			'--filter',
			'OtherTest.testFoo',
		]);
	});

	it('uses --junit with file for junit format', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'junit',
			resultFile: '/out/test-result.xml',
			verbose: false,
		});
		expect(args).to.include('--junit');
		expect(args[args.indexOf('--junit') + 1]).to.equal('/out/test-result.xml');
	});

	it('uses --json without file when no resultFile is provided', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'json',
			verbose: false,
		});
		expect(args).to.include('--json');
		const idx = args.indexOf('--json');
		// Should not be followed by a path
		expect(args[idx + 1]).to.equal(undefined);
	});

	it('adds --coverage when coverageFile is set', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			coverageFile: '/out/cov.json',
			verbose: false,
		});
		expect(args).to.include('--coverage');
		expect(args[args.indexOf('--coverage') + 1]).to.equal('/out/cov.json');
	});

	it('adds --skip-errors when skipErrors is set', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
			skipErrors: true,
		});
		expect(args).to.include('--skip-errors');
	});

	it('does not pass --skip-errors when skipErrors is unset', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
		});
		expect(args).to.not.include('--skip-errors');
	});

	it('adds --quiet when quiet is set', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
			quiet: true,
		});
		expect(args).to.include('--quiet');
	});

	it('does not pass --quiet when quiet is unset', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
		});
		expect(args).to.not.include('--quiet');
	});

	it('does not pass --junit or --json for human format', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
		});
		expect(args).to.not.include('--junit');
		expect(args).to.not.include('--json');
	});

	it('adds --default-namespace when defaultNamespace is set', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
			defaultNamespace: 'acme',
		});
		expect(args).to.include('--default-namespace');
		expect(args[args.indexOf('--default-namespace') + 1]).to.equal('acme');
	});

	it('does not pass --default-namespace when defaultNamespace is unset', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
		});
		expect(args).to.not.include('--default-namespace');
	});

	it('does not pass --default-namespace when defaultNamespace is empty', () => {
		const args = buildAerArgs({
			stagedDir: '/tmp/stage',
			filters: [],
			resultFormat: 'human',
			verbose: false,
			defaultNamespace: '',
		});
		expect(args).to.not.include('--default-namespace');
	});
});

describe('buildServerArgs', () => {
	it('starts with server, the source paths, and --watch', () => {
		const args = buildServerArgs(['/src/pkg-a', '/src/pkg-b']);
		expect(args).to.deep.equal(['server', '/src/pkg-a', '/src/pkg-b', '--watch']);
	});

	it('adds --default-namespace when a namespace is set', () => {
		const args = buildServerArgs(['/src/pkg-a'], 'acme');
		expect(args).to.include('--default-namespace');
		expect(args[args.indexOf('--default-namespace') + 1]).to.equal('acme');
	});

	it('does not add --default-namespace when namespace is undefined', () => {
		const args = buildServerArgs(['/src/pkg-a']);
		expect(args).to.not.include('--default-namespace');
	});

	it('does not add --default-namespace when namespace is empty', () => {
		const args = buildServerArgs(['/src/pkg-a'], '');
		expect(args).to.not.include('--default-namespace');
	});
});
