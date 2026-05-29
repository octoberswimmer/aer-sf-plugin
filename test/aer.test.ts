import { expect } from 'chai';
import { buildAerArgs } from '../src/aer.js';

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
});
