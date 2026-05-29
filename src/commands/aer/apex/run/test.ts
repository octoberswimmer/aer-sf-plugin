import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfProject } from '@salesforce/core';
import { stageSource, type Replacement, type PackageDirectory } from '../../../../staging.js';
import { buildAerArgs, runAer } from '../../../../aer.js';
import {
	checkForUpdate,
	ensureAerBinary,
	installAerVersion,
	recordPromptedVersion,
	type PendingUpdate,
} from '../../../../aerBinary.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@octoberswimmer/aer-sf-plugin', 'aer.apex.run.test');

type ResultFormat = 'human' | 'tap' | 'junit' | 'json';
type TestLevel = 'RunLocalTests' | 'RunAllTestsInOrg' | 'RunSpecifiedTests';

export type AerApexRunTestResult = {
	stagedDir: string;
	filters: string[];
	exitCode: number;
};

type SfProjectJsonContents = {
	packageDirectories?: PackageDirectory[];
	replacements?: Replacement[];
};

export default class AerApexRunTest extends SfCommand<AerApexRunTestResult> {
	public static readonly summary = messages.getMessage('summary');
	public static readonly description = messages.getMessage('description');
	public static readonly examples = messages.getMessages('examples');

	public static readonly flags = {
		'target-org': Flags.string({
			char: 'o',
			summary: messages.getMessage('flags.target-org.summary'),
			description: messages.getMessage('flags.target-org.description'),
		}),
		'test-level': Flags.custom<TestLevel>({
			options: ['RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests'],
		})({
			char: 'l',
			summary: messages.getMessage('flags.test-level.summary'),
		}),
		'class-names': Flags.string({
			char: 'n',
			multiple: true,
			summary: messages.getMessage('flags.class-names.summary'),
		}),
		'suite-names': Flags.string({
			char: 's',
			multiple: true,
			summary: messages.getMessage('flags.suite-names.summary'),
		}),
		tests: Flags.string({
			char: 't',
			multiple: true,
			summary: messages.getMessage('flags.tests.summary'),
		}),
		'result-format': Flags.custom<ResultFormat>({
			options: ['human', 'tap', 'junit', 'json'],
		})({
			char: 'r',
			summary: messages.getMessage('flags.result-format.summary'),
			default: 'human',
		}),
		'output-dir': Flags.directory({
			char: 'd',
			summary: messages.getMessage('flags.output-dir.summary'),
		}),
		'code-coverage': Flags.boolean({
			char: 'c',
			summary: messages.getMessage('flags.code-coverage.summary'),
		}),
		'detailed-coverage': Flags.boolean({
			char: 'v',
			summary: messages.getMessage('flags.detailed-coverage.summary'),
			dependsOn: ['code-coverage'],
		}),
		synchronous: Flags.boolean({
			char: 'y',
			summary: messages.getMessage('flags.synchronous.summary'),
		}),
		wait: Flags.integer({
			char: 'w',
			summary: messages.getMessage('flags.wait.summary'),
		}),
		'poll-interval': Flags.integer({
			char: 'i',
			summary: messages.getMessage('flags.poll-interval.summary'),
		}),
		concise: Flags.boolean({
			summary: messages.getMessage('flags.concise.summary'),
		}),
		'api-version': Flags.string({
			summary: messages.getMessage('flags.api-version.summary'),
		}),
		'skip-errors': Flags.boolean({
			summary: messages.getMessage('flags.skip-errors.summary'),
		}),
	};

	public async run(): Promise<AerApexRunTestResult> {
		const { flags } = await this.parse(AerApexRunTest);

		const project = await SfProject.resolve();
		const projectRoot = project.getPath();
		const contents = project.getSfProjectJson().getContents() as unknown as SfProjectJsonContents;
		const packageDirectories = contents.packageDirectories ?? [];
		if (packageDirectories.length === 0) {
			throw messages.createError('error.noPackageDirectories');
		}

		const filters = buildFilters(flags['class-names'], flags.tests);

		const testLevel = flags['test-level'];
		if (testLevel === 'RunAllTestsInOrg') {
			this.warn(messages.getMessage('warn.testLevelInOrgUnsupported'));
		}

		if (flags['suite-names'] && flags['suite-names'].length > 0) {
			this.warn(messages.getMessage('warn.suiteNamesUnsupported'));
		}

		const ignoredFlags: string[] = [];
		if (flags['target-org']) ignoredFlags.push('--target-org');
		if (flags.synchronous) ignoredFlags.push('--synchronous');
		if (flags.wait !== undefined) ignoredFlags.push('--wait');
		if (flags['poll-interval'] !== undefined) ignoredFlags.push('--poll-interval');
		if (flags['api-version']) ignoredFlags.push('--api-version');
		if (flags['detailed-coverage']) ignoredFlags.push('--detailed-coverage');
		if (flags.concise) ignoredFlags.push('--concise');
		if (flags['result-format'] === 'tap') ignoredFlags.push('--result-format=tap (using human instead)');
		if (ignoredFlags.length > 0) {
			this.warn(messages.getMessage('warn.ignoredFlags', [ignoredFlags.join(', ')]));
		}

		const interactive = !this.jsonEnabled() && Boolean(process.stdin.isTTY);

		const aerPath = await ensureAerBinary({
			allowPrompt: interactive,
			// Long timeout so a user with the prompt buried in scrollback still has
			// time to react; default-no keeps CI/headless runs safe.
			confirm: (message) => this.confirm({ message, ms: 5 * 60 * 1000, defaultAnswer: false }),
			log: (m) => this.log(m),
			warn: (m) => this.warn(m),
		});

		// Kick off the update check in parallel with staging and the test run.
		// Errors are swallowed — we never want this to fail the command.
		const updateCheck: Promise<PendingUpdate | null> = interactive
			? checkForUpdate({ aerPath, log: (m) => this.log(m) }).catch(() => null)
			: Promise.resolve(null);

		const staged = await stageSource({
			projectRoot,
			packageDirectories,
			replacements: contents.replacements,
		});

		let resultFile: string | undefined;
		let coverageFile: string | undefined;
		const effectiveFormat: 'human' | 'junit' | 'json' =
			flags['result-format'] === 'junit'
				? 'junit'
				: flags['result-format'] === 'json'
					? 'json'
					: 'human';
		if (flags['output-dir']) {
			const outDir = resolve(projectRoot, flags['output-dir']);
			await mkdir(outDir, { recursive: true });
			if (effectiveFormat === 'junit') {
				resultFile = join(outDir, 'test-result.xml');
			} else if (effectiveFormat === 'json') {
				resultFile = join(outDir, 'test-result.json');
			}
			if (flags['code-coverage']) {
				coverageFile = join(outDir, 'test-result-codecoverage.json');
			}
		}

		const args = buildAerArgs({
			stagedDir: staged.dir,
			filters,
			resultFormat: effectiveFormat,
			resultFile,
			coverageFile,
			verbose: flags['detailed-coverage'] ?? false,
			skipErrors: flags['skip-errors'] ?? false,
		});

		let exitCode = 0;
		try {
			exitCode = await runAer(aerPath, args, projectRoot);
		} finally {
			await staged.cleanup();
		}

		if (exitCode !== 0 && !this.jsonEnabled()) {
			this.warn(messages.getMessage('warn.aerExit', [String(exitCode)]));
		}

		await this.maybePromptForUpdate(updateCheck);

		return {
			stagedDir: staged.dir,
			filters,
			exitCode,
		};
	}

	private async maybePromptForUpdate(check: Promise<PendingUpdate | null>): Promise<void> {
		let update: PendingUpdate | null;
		try {
			update = await check;
		} catch {
			return;
		}
		if (!update) return;

		this.log('');
		const yes = await this.confirm({
			message: messages.getMessage('prompt.updateAvailable', [update.installed, update.latest]),
			ms: 5 * 60 * 1000,
			defaultAnswer: false,
		});
		if (!yes) {
			// Record only after the user has been asked and declined, so a
			// failed prompt doesn't accidentally suppress future ones.
			await recordPromptedVersion(update.latest).catch(() => {});
			this.log(messages.getMessage('info.updateDeferred'));
			return;
		}

		try {
			const newPath = await installAerVersion(update.latest, { log: (m) => this.log(m) });
			this.log(messages.getMessage('info.updateInstalled', [update.latest, newPath]));
		} catch (err) {
			this.warn(messages.getMessage('warn.updateFailed', [(err as Error).message]));
		}
	}
}

function buildFilters(classNames: string[] | undefined, tests: string[] | undefined): string[] {
	const out: string[] = [];
	for (const cn of classNames ?? []) {
		// aer matches test names like "ClassName.methodName"; anchor on class name with a glob.
		out.push(`${cn}.*`);
	}
	for (const t of tests ?? []) {
		out.push(t);
	}
	return out;
}
