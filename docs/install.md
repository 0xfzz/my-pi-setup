# Install / remove

> Part of [pi-workflow-extensions](../README.md). Install the package, reload Pi, and remove it again.

```sh
pi install /absolute/path/to/pi-workflow-extensions
# Restart Pi (or /reload in a session with no running children).
pi remove /absolute/path/to/pi-workflow-extensions
```

The local package stays in this directory. Do not delete or move it while installed. The package manifest lists each extension explicitly, so its tests and helpers are not loaded as extensions. To disable only one, use `pi config` and select this package's resources.

For development:

```sh
npm install --ignore-scripts --legacy-peer-deps   # dev-only: typescript + @types/node
npx simple-git-hooks                              # install the pre-commit lint hook (skipped by --ignore-scripts)
npm run tidy                                      # typecheck + lint:smell + test, no network or inference
```
