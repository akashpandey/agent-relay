# Agent instructions for this repo

- Do not add a `Co-Authored-By: Claude ...` (or any AI co-author) trailer to commit messages in this repository.

## Release Process & Guidelines

- **DO NOT run `npm publish` manually from the local terminal.**
- Releases are fully automated via GitHub Actions (`.github/workflows/release.yml`).
- When a version tag (`v*.*.*`) is pushed, GitHub Actions automatically:
  1. Runs the test suite (`npm test`, `test:wrappers`, `test:package`)
  2. Publishes the package to npm with cryptographic provenance using the repository's `NPM_TOKEN` secret
  3. Generates the official GitHub Release with release notes and tarball assets

### How to Cut a Release

1. Bump the version across:
   - `package.json`
   - `plugins/agent-relay/.claude-plugin/plugin.json`
   - `plugins/agent-relay/.codex-plugin/plugin.json`
   - `CHANGELOG.md`
2. Run local tests:
   ```bash
   npm test
   ./tests/test-wrappers.sh
   ```
3. Commit and tag:
   ```bash
   git add -u
   git commit -m "chore: release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   git push gitea main --tags
   ```
4. Allow GitHub Actions to publish to npm and create the GitHub Release. Do not publish locally.
