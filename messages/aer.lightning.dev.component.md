# summary

Preview Lightning Web Components locally using aer.

# description

Start a local development server powered by aer to preview Lightning Web Components in isolation with hot module replacement (HMR).

When running the development server, changes to component templates (HTML), styles (CSS), and JavaScript logic are automatically reflected in the browser.

If you run the command without flags, it displays a list of components found in your local DX project for you to choose to preview. Use the --name flag to bypass the prompt. Use --client-select to open the component list in the browser instead.

The `aer` binary is resolved in the same order as `<%= config.bin %> aer apex run test` — see that command's help for details.

# examples

- Select a component interactively and launch the preview:

  <%= config.bin %> <%= command.id %>

- Preview a specific component:

  <%= config.bin %> <%= command.id %> --name myComponent

- Open the component list in the browser:

  <%= config.bin %> <%= command.id %> --client-select

# flags.target-org.summary

Username or alias of the target org. Accepted for compatibility with `sf lightning dev component`; aer runs locally and ignores this flag.

# flags.name.summary

Name of a component to preview.

# flags.client-select.summary

Open the component list in the browser instead of selecting interactively.

# prompt.selectComponent

Select a component to preview:

# info.serverListening

aer server listening. Opening browser…

# info.serverUrl

Preview available at %s

# info.serverStopped

aer server stopped.

# error.noLwcComponents

No Lightning Web Components found in the project's package directories.

# error.componentNotFound

Component "%s" was not found. Available components: %s

# warn.ignoredFlags

The following flags were accepted for compatibility but have no effect when running locally with aer: %s

# warn.aerExit

aer exited with non-zero status %s.

# prompt.updateAvailable

A newer aer release is available (installed: %s, latest: %s). Update now?

# info.updateDeferred

Skipping aer update. You'll be prompted again the next time a new release is published.

# info.updateInstalled

Installed aer %s to %s. The new version will be used on the next run.

# warn.updateFailed

Failed to update aer: %s
