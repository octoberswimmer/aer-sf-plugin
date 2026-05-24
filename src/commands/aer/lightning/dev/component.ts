import { spawn, exec } from 'node:child_process';
import { resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfProject } from '@salesforce/core';
import select from '@inquirer/select';
import { discoverLwcComponents } from '../../../../lwc.js';
import {
	checkForUpdate,
	ensureAerBinary,
	installAerVersion,
	recordPromptedVersion,
	type PendingUpdate,
} from '../../../../aerBinary.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@octoberswimmer/aer-sf-plugin', 'aer.lightning.dev.component');

type PackageDirectory = { path: string };

type SfProjectJsonContents = {
	packageDirectories?: PackageDirectory[];
};

export type AerLightningDevComponentResult = {
	exitCode: number;
};

export default class AerLightningDevComponent extends SfCommand<AerLightningDevComponentResult> {
	public static readonly summary = messages.getMessage('summary');
	public static readonly description = messages.getMessage('description');
	public static readonly examples = messages.getMessages('examples');

	public static readonly flags = {
		'target-org': Flags.string({
			char: 'o',
			summary: messages.getMessage('flags.target-org.summary'),
		}),
		name: Flags.string({
			char: 'n',
			summary: messages.getMessage('flags.name.summary'),
		}),
		'client-select': Flags.boolean({
			char: 'c',
			summary: messages.getMessage('flags.client-select.summary'),
		}),
	};

	public async run(): Promise<AerLightningDevComponentResult> {
		const { flags } = await this.parse(AerLightningDevComponent);

		const project = await SfProject.resolve();
		const projectRoot = project.getPath();
		const contents = project.getSfProjectJson().getContents() as unknown as SfProjectJsonContents;
		const packageDirectories = contents.packageDirectories ?? [];

		if (flags['target-org']) {
			this.warn(messages.getMessage('warn.ignoredFlags', ['--target-org']));
		}

		const interactive = Boolean(process.stdin.isTTY);

		const aerPath = await ensureAerBinary({
			allowPrompt: interactive,
			confirm: (message) => this.confirm({ message, ms: 5 * 60 * 1000, defaultAnswer: false }),
			log: (m) => this.log(m),
			warn: (m) => this.warn(m),
		});

		const updateCheck: Promise<PendingUpdate | null> = interactive
			? checkForUpdate({ aerPath, log: (m) => this.log(m) }).catch(() => null)
			: Promise.resolve(null);

		let componentName: string | undefined = flags.name;
		const clientSelect = flags['client-select'] ?? false;

		if (!clientSelect) {
			const components = await discoverLwcComponents(projectRoot, packageDirectories);
			if (components.length === 0) {
				throw messages.createError('error.noLwcComponents');
			}
			if (componentName) {
				const match = components.find((c) => c.name === componentName);
				if (!match) {
					const available = components.map((c) => c.name).join(', ');
					throw messages.createError('error.componentNotFound', [componentName, available]);
				}
			} else {
				componentName = await select({
					message: messages.getMessage('prompt.selectComponent'),
					choices: components.map((c) => ({ name: c.name, value: c.name })),
				});
			}
		}

		const sourcePaths = packageDirectories.map((pd) => resolve(projectRoot, pd.path));
		const args = ['server', ...sourcePaths, '--watch'];

		const previewPath = componentName ? `/dev/lwc/${componentName}` : '/dev/lwc';

		const exitCode = await this.runServer(aerPath, args, projectRoot, previewPath);

		if (exitCode !== 0) {
			this.warn(messages.getMessage('warn.aerExit', [String(exitCode)]));
		}

		await this.maybePromptForUpdate(updateCheck);

		return { exitCode };
	}

	private runServer(binaryPath: string, args: string[], cwd: string, previewPath: string): Promise<number> {
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(binaryPath, args, {
				cwd,
				stdio: ['inherit', 'inherit', 'pipe'],
				env: {
					...process.env,
					AER_AUTOUPDATE_DISABLED: '1',
				},
			});

			let opened = false;
			let stderrBuf = '';

			child.stderr?.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				process.stderr.write(text);
				if (!opened) {
					stderrBuf += text;
					const match = stderrBuf.match(/server listening on (\S+)/);
					if (match) {
						opened = true;
						const addr = match[1];
						const url = `http://${addr}${previewPath}`;
						this.log(messages.getMessage('info.serverUrl', [url]));
						openBrowser(url);
					}
				}
			});

			child.on('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'ENOENT') {
					rejectPromise(
						new Error(
							`Could not execute aer at ${binaryPath}. The file may have been moved or deleted.`,
						),
					);
					return;
				}
				rejectPromise(err);
			});

			child.on('exit', (code, signal) => {
				if (signal) {
					resolvePromise(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
				} else {
					resolvePromise(code ?? 0);
				}
			});
		});
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

function openBrowser(url: string): void {
	const cmd =
		process.platform === 'darwin'
			? 'open'
			: process.platform === 'win32'
				? 'start'
				: 'xdg-open';
	exec(`${cmd} ${JSON.stringify(url)}`);
}
