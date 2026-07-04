# Changelog

## v0.0.8 — 2026-07-04

- **The component preview server assigns `apexTestAccess` permission sets.**
  `sf aer lightning dev component` now passes the `permissionSets` declared
  under `apexTestAccess` to the server as `--assign-perms`, matching the
  behavior of `sf aer apex run test`.

## v0.0.7 — 2026-07-03

- **`unpackagedMetadata` is loaded alongside your package source.** If a
  `packageDirectories` entry in `sfdx-project.json` declares
  `unpackagedMetadata`, its directory is staged with the packaged source when
  running `sf aer apex run test`, and served by the `sf aer lightning dev
  component` preview server. Metadata your tests or components depend on but that
  isn't part of the package is now added to the source paths.
- **`apexTestAccess` permission sets are assigned to the test user.** The
  `permissionSets` listed under a package directory's `apexTestAccess` are
  assigned to the user your Apex tests run as, so tests that require a permission
  set behave the same locally as they do during package version creation.

## v0.0.6 — 2026-07-01

- **`sfdx-project.json` `replacements` are applied to your source.** Token
  substitutions defined in `replacements` are applied before your tests run, so
  placeholders like `{NAMESPACE}` resolve to the same values `sf project deploy
  start` would deploy. The full schema is supported: `filename` or `glob`
  targeting, `stringToReplace` or `regexToReplace` matching, `replaceWithFile` or
  `replaceWithEnv` values, the `replaceWhenEnv` condition, and
  `allowUnsetEnvVariable`. Binary files are left untouched.
- **`sfdx-project.json` `namespace` sets aer's default namespace.** When your
  project defines a non-empty `namespace`, both `sf aer apex run test` and the
  component preview server treat the loaded code as belonging to that namespace,
  so references resolve the way they do for the packaged code in an org.
- **`--concise` now hides passing tests.** The `--concise` flag maps to aer's
  quiet output, printing only failures and the run summary.

## v0.0.5 — 2026-05-29

- **`--skip-errors` runs tests despite parse or type errors.** Tests that don't
  depend on the broken code still run, instead of the whole run failing when some
  classes have parse or type-checking errors.

## v0.0.4 — 2026-05-24

- **Preview Lightning Web Components locally with `sf aer lightning dev
  component`.** Launches a local development server that previews a component
  with hot module replacement, so edits to a component's HTML, CSS, and
  JavaScript appear in the browser immediately. Pick a component interactively,
  pass `--name` to preview a specific one, or use `--client-select` to choose in
  the browser.

## v0.0.3 — 2026-05-21

- **You're prompted to upgrade aer when a newer release ships.** When the plugin
  manages its own copy of aer, it checks for newer releases in the background
  (at most once every 12 hours) and, after a run, offers to install an update.
  Decline and the same version won't be offered again until something newer is
  published.

## v0.0.2 — 2026-05-20

- **aer is downloaded automatically when it isn't already installed.** If the
  plugin can't find aer via `AER_BIN`, a previous download, or your `PATH`, it
  offers to download the right build for your platform and reuses it on later
  runs. Non-interactive runs (CI, `--json`) never prompt.

## v0.0.1 — 2026-05-19

- **Run Apex tests locally with `sf aer apex run test`.** A drop-in replacement
  for `sf apex run test` that runs your tests locally with aer instead of
  submitting them to an org. It accepts the same flags and loads every
  `packageDirectories` entry together, resolving duplicate Apex class names the
  way a deploy would. Flags that only make sense against a real org are
  accepted for compatibility and ignored with a warning.
