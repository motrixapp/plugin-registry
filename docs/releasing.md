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

- **builtin-plugins secret `REGISTRY_DISPATCH_TOKEN`** — a fine-scoped PAT or
  GitHub App token permitted to `POST repos/motrixapp/plugin-registry/dispatches`.
  Until it is set, the release workflow's notify step is a no-op (a shell
  guard skips it) and the release still succeeds.
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
