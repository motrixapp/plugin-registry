# Registry entry automation

A signed `builtin-plugins` release notifies this repo (`repository_dispatch`,
event type `builtin-released`); the `registry-entry-update` workflow
regenerates that plugin's entry — downloading the release assets, verifying
the Ed25519 signature against `keys/signing-key.pub.pem`, and binding the
in-bundle `motrix-plugin.json` id/version to the tag — then opens a PR. The
normal `validate` / `test` / lockstep CI gates the PR before a human merges.

The generator (`scripts/entry-from-release.ts`) is the single source of this
logic; it is also used to populate entries manually (`pnpm entry:from-release`).

## One-time setup (repo admin)

- **builtin-plugins → a GitHub App for the cross-repo dispatch.** Create an
  org-owned GitHub App with the single Repository permission **Contents:
  Read and write** (what `repository_dispatch` requires), install it on
  `motrixapp/plugin-registry` only, and store its credentials in
  builtin-plugins' **`plugin-signing` environment**:
  - `REGISTRY_DISPATCH_APP_ID` — the App ID (secret or variable),
  - `REGISTRY_DISPATCH_APP_PRIVATE_KEY` — the App private key `.pem` (secret).

  The release workflow's `sign` job mints a short-lived (~1h), repo-scoped
  installation token from these (`actions/create-github-app-token`) and uses
  it to `POST repos/motrixapp/plugin-registry/dispatches`. This is a distinct
  credential from the Ed25519 signing key (`MOTRIX_PLUGIN_SIGNING_KEY`) —
  same environment, far lower sensitivity. Until BOTH App secrets are set,
  the mint + notify steps skip (gated on a credentials-present check) and the
  signed release still succeeds.
- **plugin-registry setting** — Settings → Actions → General → "Allow GitHub
  Actions to create and approve pull requests" must be enabled so the
  workflow's `GITHUB_TOKEN` can open the PR.

## Manual fallback

No dispatch token needed — trigger the workflow directly:

```bash
gh workflow run registry-entry-update.yml -f id=<id> -f tag=<id>@<version>
```

(or the Actions UI). This regenerates and PRs the entry exactly as the
automated path does.

## Security notes

- `repository_dispatch` `client_payload` is attacker-settable by anyone
  holding the dispatch token, so the workflow treats `id`/`tag` as untrusted:
  they are passed through `env:` (never interpolated into a shell) and
  strictly validated (`^motrix\.[a-z0-9][a-z0-9-]*$` and a `<id>@<semver>`
  tag) before use.
- Even a validly-shaped but malicious payload cannot publish a bad package:
  the generator downloads only from the `builtin-plugins` releases, verifies
  the pinned-key Ed25519 signature over the `.moext` bytes, and rejects the
  entry unless the signed in-bundle manifest's id/version match the tag.
