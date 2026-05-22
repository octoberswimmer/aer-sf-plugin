# @octoberswimmer/aer-sf-plugin

A [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) plugin
that runs Apex tests locally using [aer](https://github.com/octoberswimmer/aer-dist).

```
sf aer apex run test
```

works the same way as

```
sf apex run test
```

but instead of submitting tests to a Salesforce org, it stages your project's
Apex source into a temp directory and invokes `aer test` against the staged
copy.

## Requirements

- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`)
- Node.js >= 18
- [aer](https://github.com/octoberswimmer/aer-dist) — the plugin will offer to
  download the right build for your platform on first use if it can't find one
  already (see [Locating the aer binary](#locating-the-aer-binary) below).

## Install

From npm:

```
sf plugins install @octoberswimmer/aer-sf-plugin
```

## Usage

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
   [aer-dist](https://github.com/octoberswimmer/aer-dist) release for your
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
staging — `stringToReplace` or `regexToReplace` paired with either
`replaceWithFile` or `replaceWithEnv`. A single trailing newline is trimmed
from `replaceWithFile` contents, matching
`@salesforce/source-deploy-retrieve`.

### Duplicate Apex class names across `packageDirectories` are resolved

If the same Apex class name appears in more than one `packageDirectories`
entry, `sf project deploy start` deploys the copies in full-path alphabetical
order, so the copy at the alphabetically-last full path is the one that ends
up in the org. `aer test` rejects this and errors on duplicates.

To match sf's behaviour, the plugin dedupes `.cls` / `.cls-meta.xml` /
`.trigger` / `.trigger-meta.xml` files by basename (case-insensitive). The
copy whose full path sorts alphabetically last is staged; the others are
discarded. Listing order in `sfdx-project.json` does not affect the outcome.

## Flag compatibility with `sf apex run test`

| flag | behaviour |
| --- | --- |
| `--class-names`, `--tests` | translated to aer `--filter` |
| `--result-format human\|junit\|json` | passed through (tap falls back to human) |
| `--output-dir` | result files written here |
| `--code-coverage` | passed to aer as `--coverage` (JSON file) |
| `--test-level RunLocalTests`, `RunSpecifiedTests` | runs locally |
| `--test-level RunAllTestsInOrg` | warns; falls back to running all local tests |
| `--suite-names` | warns; not yet implemented |
| `--target-org`, `--wait`, `--poll-interval`, `--synchronous`, `--api-version`, `--concise`, `--detailed-coverage` | accepted for compatibility; ignored (a warning is printed when any of these is supplied) |

## Development

```
yarn install
yarn compile       # tsc
yarn test          # mocha unit tests
node bin/dev.js aer apex run test --help
```

## License

This plugin is open source, licensed under BSD-3-Clause.

Note that [aer](https://github.com/octoberswimmer/aer-dist) itself is not open
source — it is distributed as a binary under its own license.
