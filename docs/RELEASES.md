# Publish a GitHub release

As checked on 2026-09-18, `akashpandey/agent-relay` is private and has no GitHub
releases or version tags. The plugin, installer, and dashboard restart changes
are pushed in `488d322`, and CI passed for that commit. Include any subsequent
documentation changes in the candidate and verify CI for its exact commit.

A release is a versioned Git tag plus release notes and optional downloadable
files. It does not publish an npm package or make a private repository public.
See [GitHub's release instructions](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).

## 1. Prepare the candidate

Review and commit the intended changes, push them to main, and wait for the
repository CI to pass for that exact commit. Include the plugin catalogs,
bundles, installer fix, documentation, and tests. Preserve unrelated local work.
For the first candidate, the current package/plugin version is `1.0.0`.
Future releases must update both plugin manifests and the Claude catalog version
alongside `package.json`.

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
git tag -a v1.0.0 -m "agent-relay v1.0.0"
git push origin v1.0.0
mkdir -p /tmp/agent-relay-v1.0.0
npm pack --pack-destination /tmp/agent-relay-v1.0.0
(cd /tmp/agent-relay-v1.0.0 && sha256sum akashpandey-agent-relay-1.0.0.tgz > SHA256SUMS)
gh release create v1.0.0 --verify-tag --draft --title "agent-relay v1.0.0" --generate-notes /tmp/agent-relay-v1.0.0/akashpandey-agent-relay-1.0.0.tgz /tmp/agent-relay-v1.0.0/SHA256SUMS
```

Review the draft's notes, exact tagged commit, included files, and known limits.
Then publish through the repository's Releases page. These commands require
repository write access and authenticated Git/GitHub CLI.

## 3. Public availability and remote plugin checks

For an open-source release, review the repository contents and history before
changing visibility in GitHub Settings. A private release is visible only to
people with repository access. Making the repository public is a separate
publication decision; these local changes do not change visibility.

Once the plugin catalogs are pushed, verify the remote marketplace from another
machine or a fresh profile using an account with repository access:

```bash
claude plugin marketplace add akashpandey/agent-relay
claude plugin install agent-relay@agent-relay
codex plugin marketplace add akashpandey/agent-relay --ref v1.0.0
codex plugin add agent-relay@agent-relay
```

An existing local marketplace with the same name must first be removed or tested
in another profile. Antigravity and OpenCode can use a checkout of the release
tag and their documented local plugin commands. Verify real tool calls after
loading, not just marketplace installation.

For users installing the attached archive:

```bash
mkdir -p "$HOME/agent-relay"
tar -xzf akashpandey-agent-relay-1.0.0.tgz -C "$HOME/agent-relay" --strip-components=1
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
The scoped archive filename is `akashpandey-agent-relay-1.0.0.tgz`.

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
[npm installation steps](GETTING_STARTED.md#npm-installation).
