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
- [aer](https://github.com/octoberswimmer/aer-dist) on `PATH` (or set
  `AER_BIN=/abs/path/to/aer`)
- Node.js >= 18

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
source — it is distributed as a binary under its own license. You must obtain
and install aer separately for the plugin to do anything useful.
