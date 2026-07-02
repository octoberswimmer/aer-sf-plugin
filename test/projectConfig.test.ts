import { expect } from 'chai';
import {
	collectSourceDirectories,
	collectAssignPerms,
	collectPermissionSetLicenses,
} from '../src/staging.js';

describe('collectSourceDirectories', () => {
	it('returns each packageDirectory path unchanged when no unpackagedMetadata is present', () => {
		const dirs = collectSourceDirectories([{ path: 'force-app' }, { path: 'util' }]);
		expect(dirs).to.deep.equal([{ path: 'force-app' }, { path: 'util' }]);
	});

	it('appends each unpackagedMetadata path after its packageDirectory', () => {
		const dirs = collectSourceDirectories([
			{ path: 'force-app', unpackagedMetadata: { path: 'my-unpackaged-directory' } },
			{ path: 'util' },
		]);
		expect(dirs).to.deep.equal([
			{ path: 'force-app' },
			{ path: 'my-unpackaged-directory' },
			{ path: 'util' },
		]);
	});

	it('ignores an unpackagedMetadata entry without a path', () => {
		const dirs = collectSourceDirectories([
			{ path: 'force-app', unpackagedMetadata: {} as { path: string } },
		]);
		expect(dirs).to.deep.equal([{ path: 'force-app' }]);
	});
});

describe('collectAssignPerms', () => {
	it('returns an empty array when no apexTestAccess is configured', () => {
		expect(collectAssignPerms([{ path: 'force-app' }])).to.deep.equal([]);
	});

	it('collects permissionSets from apexTestAccess', () => {
		const perms = collectAssignPerms([
			{
				path: 'force-app',
				apexTestAccess: { permissionSets: ['Permission_Set_1', 'Permission_Set_2'] },
			},
		]);
		expect(perms).to.deep.equal(['Permission_Set_1', 'Permission_Set_2']);
	});

	it('dedupes permissionSets across packageDirectories, preserving first-seen order', () => {
		const perms = collectAssignPerms([
			{ path: 'force-app', apexTestAccess: { permissionSets: ['A', 'B'] } },
			{ path: 'util', apexTestAccess: { permissionSets: ['B', 'C'] } },
		]);
		expect(perms).to.deep.equal(['A', 'B', 'C']);
	});
});

describe('collectPermissionSetLicenses', () => {
	it('returns an empty array when no licenses are configured', () => {
		expect(collectPermissionSetLicenses([{ path: 'force-app' }])).to.deep.equal([]);
	});

	it('collects and dedupes permissionSetLicenses across packageDirectories', () => {
		const licenses = collectPermissionSetLicenses([
			{ path: 'force-app', apexTestAccess: { permissionSetLicenses: ['SalesConsoleUser'] } },
			{ path: 'util', apexTestAccess: { permissionSetLicenses: ['SalesConsoleUser', 'Other'] } },
		]);
		expect(licenses).to.deep.equal(['SalesConsoleUser', 'Other']);
	});
});
