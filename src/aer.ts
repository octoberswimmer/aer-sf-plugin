import { spawn } from 'node:child_process';

export type AerResultFormat = 'human' | 'junit' | 'json' | 'tap';

export type AerInvocation = {
	stagedDir: string;
	filters: string[];
	resultFormat: AerResultFormat;
	resultFile?: string;
	coverageFile?: string;
	verbose: boolean;
};

export function buildAerArgs(inv: AerInvocation): string[] {
	const args: string[] = ['test', inv.stagedDir];
	for (const f of inv.filters) {
		args.push('--filter', f);
	}
	if (inv.resultFormat === 'junit' && inv.resultFile) {
		args.push('--junit', inv.resultFile);
	} else if (inv.resultFormat === 'json' && inv.resultFile) {
		args.push('--json', inv.resultFile);
	} else if (inv.resultFormat === 'json' && !inv.resultFile) {
		// aer's --json without a file writes to stdout
		args.push('--json');
	}
	if (inv.coverageFile) {
		args.push('--coverage', inv.coverageFile);
	}
	return args;
}

export function aerBinary(): string {
	return process.env.AER_BIN ?? 'aer';
}

export async function runAer(args: string[], cwd: string): Promise<number> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(aerBinary(), args, {
			cwd,
			stdio: 'inherit',
		});
		child.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT') {
				rejectPromise(
					new Error(
						`Could not find the 'aer' binary on PATH. Install aer from https://github.com/octoberswimmer/aer-dist or set AER_BIN to its absolute path.`,
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
