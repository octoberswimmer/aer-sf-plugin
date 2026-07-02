# @octoberswimmer/aer-sf-plugin

A [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) plugin
that runs Apex tests and previews Lightning Web Components locally using
[aer](https://aertest.com).

```
sf aer apex run test
```

works the same way as `sf apex run test`, but runs tests locally via `aer test`.

```
sf aer lightning dev component
```

works the same way as `sf lightning dev component`, but previews LWC components
locally via `aer server`.

## Requirements

- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`)
- Node.js >= 18
- [aer](https://aertest.com) — the plugin will offer to
  download the right build for your platform on first use if it can't find one
  already (see [Locating the aer binary](#locating-the-aer-binary) below).

## Install

From npm:

```
sf plugins install @octoberswimmer/aer-sf-plugin
```

## Usage

### Apex tests

Run every test in the project:

```
sf aer apex run test
```

Run one or more classes (passed to aer as `--filter <ClassName>.*`):

```
sf aer apex run test --class-names MyClassTest --class-names AccountServiceTest
```

Run a single method:

```
sf aer apex run test --tests MyClassTest.testCoolFeature
```

JUnit output:

```
sf aer apex run test --result-format junit --output-dir test-results
```

With code coverage:

```
sf aer apex run test --code-coverage --output-dir test-results
```

Run tests even when some classes have parse or type errors:

```
sf aer apex run test --skip-errors
```

### LWC component preview

Select a component interactively and launch the preview:

```
sf aer lightning dev component
```

Preview a specific component by name:

```
sf aer lightning dev component --name myComponent
```

Open the component list in the browser instead of selecting interactively:

```
sf aer lightning dev component --client-select
```

The development server uses `aer server --watch` to serve your project's
source directly (no staging), so changes to component HTML, CSS, and
JavaScript are reflected immediately via hot module replacement.

## Locating the aer binary

When the plugin needs to invoke `aer`, it tries these sources in order:

1. The `AER_BIN` environment variable, when it points to an executable file.
2. A copy previously downloaded by this plugin, stored under a platform-specific
   data directory:
   - Linux: `$XDG_DATA_HOME/aer-sf-plugin/aer-bin/` (default
     `~/.local/share/aer-sf-plugin/aer-bin/`)
   - macOS: `~/Library/Application Support/aer-sf-plugin/aer-bin/`
   - Windows: `%LOCALAPPDATA%\aer-sf-plugin\aer-bin\`
3. `aer` discovered on `PATH`.
4. If none of the above match and the terminal is interactive, the plugin asks
   for confirmation, then downloads the latest
   [aer](https://github.com/octoberswimmer/aer-dist) release for your
   platform, extracts it into the data directory above, and uses it for that
   run and all later runs.

### Update checks

Once the plugin has downloaded its own copy of `aer`, each subsequent run starts
a background GitHub query (rate-limited to one check every 12 hours) to see
whether a newer release has been published. The query runs in parallel with
staging and the test execution, so it does not slow tests down. After the test
run finishes, if a newer release is available you'll be prompted to install it.
Decline and the same version won't be re-offered until something newer ships.

The check is skipped entirely when:

- `AER_BIN` is set or `aer` is on `PATH` (i.e. the user manages their own copy).
- The terminal is non-interactive (`--json`, no TTY).

To force an update outside the 12-hour window, delete the contents of the
`aer-bin/` directory (or the whole `aer-sf-plugin/` directory) and rerun.

In non-interactive environments (CI, `--json`) the plugin will not prompt; set
`AER_BIN` or install `aer` on `PATH` ahead of time.

## How source is staged

The plugin copies the project's Apex source into a temp directory before
handing it to aer. Two things happen during staging.

### sfdx-project.json `replacements` are applied

Salesforce CLI supports a `replacements` configuration that substitutes tokens
in source files at deploy time:

```json
{
  "replacements": [
    {
      "glob": "*.*",
      "stringToReplace": "{NAMESPACE}",
      "replaceWithFile": "config/namespace.txt"
    }
  ]
}
```

aer does not process `replacements`, so without staging, tokens like
`{NAMESPACE}` would remain literal in the loaded source and code such as
`Label.get('{NAMESPACE}', labelName, language)` would fail at runtime. The
plugin reads `replacements` from `sfdx-project.json` and applies them during
staging, matching `@salesforce/source-deploy-retrieve` so that the staged
source is byte-for-byte what `sf project deploy start` would deploy. Every
property of the replacements schema is supported:

- **Target** — `filename` (an exact project-relative path) or `glob`.
- **Match** — `stringToReplace` (literal) or `regexToReplace` (a regular
  expression). Both replace all occurrences.
- **Replacement** — `replaceWithEnv` (an environment variable) or
  `replaceWithFile` (a file's contents, with surrounding whitespace trimmed).
- **Conditional** — `replaceWhenEnv` applies the replacement only when every
  listed `{ env, value }` matches the environment; `allowUnsetEnvVariable`
  removes the string (replaces with nothing) when the `replaceWithEnv` variable
  is unset instead of erroring.

Replacements only touch text files; binary files are copied through untouched.

### sfdx-project.json `namespace` sets aer's default namespace

If `sfdx-project.json` has a non-empty `namespace`, the plugin passes it to aer
as `--default-namespace` — both when running tests (`aer apex run test`) and
when starting the component preview server (`aer lightning dev component`) — so
the loaded code is treated as belonging to that namespace, matching how the
package's own Apex resolves references in the org. An absent or empty
`namespace` leaves the flag off.

### Duplicate Apex class names across `packageDirectories` are resolved

If the same Apex class name appears in more than one `packageDirectories`
entry, `sf project deploy start` deploys the copies in full-path alphabetical
order, so the copy at the alphabetically-last full path is the one that ends
up in the org. `aer test` rejects this and errors on duplicates.

To match sf's behaviour, the plugin dedupes `.cls` / `.cls-meta.xml` /
`.trigger` / `.trigger-meta.xml` files by basename (case-insensitive). The
copy whose full path sorts alphabetically last is staged; the others are
discarded. Listing order in `sfdx-project.json` does not affect the outcome.

### `unpackagedMetadata` is staged with the packaged source

Salesforce CLI lets you point a `packageDirectories` entry at metadata that
isn't part of the package but is needed for package-version-creation tests:

```json
{
  "packageDirectories": [
    {
      "path": "force-app",
      "package": "TV_unl",
      "default": true,
      "unpackagedMetadata": { "path": "my-unpackaged-directory" }
    }
  ]
}
```

The plugin stages each entry's `unpackagedMetadata.path` alongside the packaged
source, so the Apex tests compile and run against that metadata just as they
would during package version creation. The component preview server
(`aer lightning dev component`) likewise serves the unpackaged directories, so
LWC components and Apex it depends on from unpackaged metadata are available and
previewable.

### `apexTestAccess.permissionSets` are assigned to the test user

If a `packageDirectories` entry declares `apexTestAccess`, the plugin passes its
`permissionSets` to aer as `--assign-perms`, so the tests run with those
permission sets assigned to the sandbox user:

```json
{
  "packageDirectories": [
    {
      "path": "force-app",
      "apexTestAccess": {
        "permissionSets": ["Permission_Set_1", "Permission_Set_2"],
        "permissionSetLicenses": ["SalesConsoleUser"]
      }
    }
  ]
}
```

Permission sets collected across all `packageDirectories` are deduplicated.
`permissionSetLicenses` has no local equivalent in aer and is ignored with a
warning.

## Flag compatibility with `sf apex run test`

| flag | behaviour |
| --- | --- |
| `--class-names`, `--tests` | translated to aer `--filter` |
| `--result-format human\|junit\|json` | passed through (tap falls back to human) |
| `--output-dir` | result files written here |
| `--code-coverage` | passed to aer as `--coverage` (JSON file) |
| `--skip-errors` | passed to aer as `--skip-errors` (display but skip parse/type errors so unaffected tests still run) |
| `--concise` | passed to aer as `--quiet` (only output failures and the summary) |
| `--test-level RunLocalTests`, `RunSpecifiedTests` | runs locally |
| `--test-level RunAllTestsInOrg` | warns; falls back to running all local tests |
| `--suite-names` | warns; not yet implemented |
| `--target-org`, `--wait`, `--poll-interval`, `--synchronous`, `--api-version`, `--detailed-coverage` | accepted for compatibility; ignored (a warning is printed when any of these is supplied) |

## Development

```
yarn install
yarn compile       # tsc
yarn test          # mocha unit tests
node bin/dev.js aer apex run test --help
```

## License

This plugin is open source, licensed under BSD-3-Clause.

Note that [aer](https://aertest.com) itself is not open
source — it is distributed as a binary under its own license.
