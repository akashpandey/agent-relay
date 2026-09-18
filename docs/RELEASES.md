# Publish a release

## Automated path (current)

`.github/workflows/release.yml` runs on any pushed tag matching `v*.*.*`. It
verifies the tag matches `package.json`'s version, runs the full test suite
(`npm test`, `test:wrappers`, `test:package`), publishes to npm with
provenance using the `NPM_TOKEN` repo secret, then builds the tarball +
`SHA256SUMS` and publishes a GitHub release immediately (not a draft) via
`gh release create --generate-notes`.

To cut a release: bump `package.json` (and both plugin manifests / the Claude
marketplace entry if the skill changed), commit, push to `main`, wait for
`main`'s CI to pass, then:

```bash
git tag -a vX.Y.Z -m "agent-relay vX.Y.Z"
git push origin vX.Y.Z
```

Everything else — npm publish, tarball, checksums, GitHub release — happens in
CI. Watch the `Release` workflow run; a failure there (e.g. a version
mismatch) leaves npm/GitHub untouched, so it's safe to fix and re-tag.

`NPM_TOKEN` must be a valid npm automation/granular token with publish access
to `@akashpandey/agent-relay` (`gh secret set NPM_TOKEN`); rotate it before it
expires or publish steps will fail with an auth error, not a silent no-op.

## Manual path (reference / fallback)

The steps below predate the workflow above and still work if you need to
publish by hand — for example, to test a pre-release build without tagging,
or if the automated workflow is broken.

As checked on 2026-09-18, `akashpandey/agent-relay` is public and has no GitHub
releases or version tags. `@akashpandey/agent-relay@1.0.0` is published on npm;
installation by package name passed CLI, MCP, and dashboard checks. CI passed
for `27610d5`. Include subsequent changes in the candidate and verify CI for
its exact commit.

A release is a versioned Git tag plus release notes and optional downloadable
files. It does not publish an npm package or make a private repository public.
See [GitHub's release instructions](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).

## 1. Prepare the candidate

Review and commit the intended changes, push them to main, and wait for the
repository CI to pass for that exact commit. Include the plugin catalogs,
bundles, installer fix, documentation, and tests. Preserve unrelated local work.
For the first GitHub release, the current package/plugin version is `1.0.1`.
Future releases must update both plugin manifests and the Claude catalog version
alongside `package.json`.

GitHub protects `main` against deletion and force pushes for everyone. A separate
ruleset requires `Lint & Mock Test Suite`, with administrator bypass to preserve
the local post-commit hook's direct pushes. That bypass does not exempt a release
candidate from passing CI for its exact commit.

From a clean checkout of the candidate commit:

```bash
npm test
npm run test:wrappers
npm run test:package
git diff --check
```

The package check requires Docker and uses an isolated Node 22 container to test
archive installation, npm global installation, the relay command, MCP
initialization, and dashboard HTTP.
It makes no model calls. Set `AGENT_RELAY_TEST_IMAGE` to another Node image to
check a different supported runtime. Provider credentials are not mounted.

## 2. Create the tag and draft release

Only run these after the candidate is committed, pushed, and verified:

```bash
git tag -a v1.0.1 -m "agent-relay v1.0.1"
git push origin v1.0.1
mkdir -p /tmp/agent-relay-v1.0.1
npm pack --pack-destination /tmp/agent-relay-v1.0.1
(cd /tmp/agent-relay-v1.0.1 && sha256sum akashpandey-agent-relay-1.0.1.tgz > SHA256SUMS)
gh release create v1.0.1 --verify-tag --draft --title "agent-relay v1.0.1" --generate-notes /tmp/agent-relay-v1.0.1/akashpandey-agent-relay-1.0.1.tgz /tmp/agent-relay-v1.0.1/SHA256SUMS
```

Review the draft's notes, exact tagged commit, included files, and known limits.
Then publish through the repository's Releases page. These commands require
repository write access and authenticated Git/GitHub CLI.

## 3. Public availability and remote plugin checks

The repository is public, so users can clone it and access its plugin catalogs
without private-repository access. GitHub releases remain a separate step from
repository visibility and npm publication.

Once the plugin catalogs are pushed, verify the remote marketplace from another
machine or a fresh profile:

```bash
claude plugin marketplace add akashpandey/agent-relay
claude plugin install agent-relay@agent-relay
codex plugin marketplace add akashpandey/agent-relay --ref v1.0.1
codex plugin add agent-relay@agent-relay
```

An existing local marketplace with the same name must first be removed or tested
in another profile. Antigravity and OpenCode can use a checkout of the release
tag and their documented local plugin commands. Verify real tool calls after
loading, not just marketplace installation.

For users installing the attached archive:

```bash
mkdir -p "$HOME/agent-relay"
tar -xzf akashpandey-agent-relay-1.0.1.tgz -C "$HOME/agent-relay" --strip-components=1
cd "$HOME/agent-relay"
./install-skill
```

Continue with the [dashboard guide](GETTING_STARTED.md). Archive installations
are not Git checkouts: update by extracting a newer archive after backing up
configuration, logs, and data, rather than running `git pull`.

GitHub provides source archives automatically for the tag. The attached npm
archive is a tested installable bundle; uploading it to GitHub does not publish
it to the npm registry. No hosted agent service or dashboard is created by a
release.

## 4. Publish to npm separately

The package name is `@akashpandey/agent-relay` because the unscoped
`agent-relay` name belongs to another project. `publishConfig.access` is `public`;
CLI command names, Git tags, and harness plugin names remain `agent-relay` / `relay`.
The scoped archive filename is `akashpandey-agent-relay-1.0.1.tgz`.

Before publishing, authenticate to npm and verify that your npm account owns the
`@akashpandey` scope or has permission to publish in it. A matching GitHub username
does not establish npm ownership, and a registry 404 does not establish permission.
If your npm account uses a different scope, update `package.json` and these docs.

npm also requires account two-factor authentication (2FA) or a granular access
token with bypass 2FA enabled for publishing. For interactive publication, enable
[account 2FA](https://docs.npmjs.com/configuring-two-factor-authentication), log in
again, and complete the browser authentication prompt when publishing.

From the verified release checkout:

```bash
npm login
npm whoami
npm publish --dry-run
# After reviewing the dry run and confirming scope access:
npm publish
```

Publishing makes the package files public on npm even if the GitHub repository
is private. A GitHub release does not perform this step. After publication, verify
`npm view @akashpandey/agent-relay version` and follow the
[npm installation steps](GETTING_STARTED.md#2-install).
