# summary

Run Apex tests locally using aer.

# description

Run Apex tests against a local sandbox using aer instead of submitting them to a Salesforce org.

This command accepts the same flags as `sf apex run test` so it can be used as a drop-in replacement, but flags that only make sense when running against a real org (--target-org, --wait, --poll-interval, --synchronous, --api-version) are accepted for compatibility and otherwise ignored.

Source is staged into a temporary directory before invoking aer. The staging step reproduces two behaviors of `sf project deploy start` that aer does not implement natively:

1. When the same Apex class name appears in more than one packageDirectories entry, the copy whose full path sorts alphabetically last wins.
2. The `replacements` configuration in sfdx-project.json (stringToReplace / regexToReplace + replaceWithFile / replaceWithEnv) is applied to file contents during staging.

The `aer` binary (https://github.com/octoberswimmer/aer-dist) is resolved in the following order:

1. The `AER_BIN` environment variable, when set to an executable file.
2. A copy previously downloaded by this plugin (stored under a platform-specific data directory, e.g. `~/.local/share/aer-sf-plugin/aer-bin/`).
3. `aer` discovered on `PATH`.
4. If none of the above match and the terminal is interactive, you'll be prompted to download the latest release for your platform from GitHub; the binary is then stored in the plugin's data directory and used for subsequent runs.

# examples

- Run every Apex test in the project:

  <%= config.bin %> <%= command.id %>

- Run a specific Apex test class:

  <%= config.bin %> <%= command.id %> --class-names MyClassTest

- Run a single test method:

  <%= config.bin %> <%= command.id %> --tests MyClassTest.testCoolFeature

- Write JUnit results to a directory:

  <%= config.bin %> <%= command.id %> --result-format junit --output-dir test-results

- Collect code coverage:

  <%= config.bin %> <%= command.id %> --code-coverage --output-dir test-results

- Run tests even when some classes have parse or type errors:

  <%= config.bin %> <%= command.id %> --skip-errors

# flags.target-org.summary

Username or alias of the target org. Accepted for compatibility with `sf apex run test`; aer runs locally and ignores this flag.

# flags.target-org.description

aer does not connect to an org. This flag is parsed for drop-in compatibility but has no effect.

# flags.test-level.summary

Level of tests to run. RunLocalTests and RunSpecifiedTests run locally via aer; RunAllTestsInOrg is unsupported.

# flags.class-names.summary

Apex test class names to run; passed to aer as `--filter <ClassName>.*`. Can be repeated.

# flags.suite-names.summary

Apex test suite names to run. Not yet supported by this plugin; a warning is printed if used.

# flags.tests.summary

Specific Apex test methods to run (e.g. MyClassTest.testFoo). Passed to aer as `--filter`. Can be repeated.

# flags.result-format.summary

Format of the test results: human, junit, json. tap is accepted but falls back to human.

# flags.output-dir.summary

Directory to write test result files (test-result.xml for junit, test-result.json for json, test-result-codecoverage.json for coverage).

# flags.code-coverage.summary

Collect Apex code coverage. Output is written under --output-dir.

# flags.detailed-coverage.summary

Accepted for compatibility; aer's coverage output is not yet broken down per test.

# flags.synchronous.summary

Accepted for compatibility; aer always runs tests synchronously.

# flags.wait.summary

Accepted for compatibility; aer runs synchronously so there is nothing to wait for.

# flags.poll-interval.summary

Accepted for compatibility; aer does not poll an org.

# flags.concise.summary

Accepted for compatibility; not yet wired into aer's output.

# flags.api-version.summary

Accepted for compatibility; aer does not talk to the org API.

# flags.skip-errors.summary

Display but skip parse and type checking errors, allowing tests to run if they don't depend on the affected code. Passed through to aer as `--skip-errors`.

# warn.testLevelInOrgUnsupported

--test-level RunAllTestsInOrg is not supported when running tests locally. All tests in the project will be run.

# warn.suiteNamesUnsupported

--suite-names is not yet supported by this plugin; the flag was ignored. Use --class-names or --tests to select tests.

# warn.ignoredFlags

The following flags were accepted for compatibility but have no effect when running tests locally with aer: %s

# warn.aerExit

aer exited with non-zero status %s.

# error.noPackageDirectories

sfdx-project.json must contain at least one packageDirectories entry.

# prompt.updateAvailable

A newer aer release is available (installed: %s, latest: %s). Update now?

# info.updateDeferred

Skipping aer update. You'll be prompted again the next time a new release is published.

# info.updateInstalled

Installed aer %s to %s. The new version will be used on the next run.

# warn.updateFailed

Failed to update aer: %s
