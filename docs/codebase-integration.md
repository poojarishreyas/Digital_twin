# GitHub source and repair workflow

Open **Codebase** and connect a GitHub repository root URL. Connections are stored in PostgreSQL per workspace, not localStorage. Attack analysis remains locked without a connected repository, including the production path API.

This release supports the exact `larkspur-vulnerable-shop` lab provided on the Desktop. Its canonical source is under `ingestion/twin_ingestion/codebase_lab/`. The GitHub API reads `twinlab.json`, `app.py` and `auth.py` at the default branch's immutable commit. Arbitrary application analysis, repository execution and LLM patch generation are not implemented. Modified unsupported source is rejected instead of guessed at.

## PR write access

Public lab repositories can be connected without credentials. To create repair pull requests, a platform administrator must mount a server-side credential configuration. The default path is `/run/twin-auth/github.json` in the existing read-only auth-directory mount. Override it with `TWIN_GITHUB_TOKENS_FILE` if necessary.

Example shape (replace placeholder strings outside the browser):

```json
{
  "your-workspace-id": {
    "repositories": ["your-github-account/larkspur-vulnerable-shop"],
    "token": "YOUR_REPOSITORY_SCOPED_GITHUB_TOKEN"
  }
}
```

Use a fine-grained token restricted to the intended repository with Contents read/write and Pull requests read/write permissions. Do not commit this file or put a token in a repository URL, chat message or frontend setting. Keep the host file readable only by its administrator. The configuration binds access to both workspace and repository. There is no shared unrestricted token fallback.

On the existing control instance, the host directory `/opt/twin/secrets/auth/` is mounted at `/run/twin-auth/`. Place `github.json` there through your normal secret-management process. No control-plane restart is required to read an updated credential file. This feature does not create a GitHub token on your behalf.

## Fix semantics

**Fix now** re-reads the default branch and refuses to patch if its commit changed since analysis. It changes only the supported `list_orders()` implementation on a new `twinhunter/order-auth-<commit>` branch and opens a reviewable PR. Repeated requests return the existing open PR. A partial operation can resume without force-pushing. No main-branch write, automatic merge, shell command, repository test execution or AWS deployment occurs.

Review the exact diff and run `python -m unittest test_security -v` locally or on an isolated candidate. After merging, **Refresh source** verifies the default branch against the known repaired source. The next three-minute walkthrough reports no remaining path for this source issue. The running AWS shop remains a separate deployment; repository correspondence and runtime security still require validation.

References: [GitHub contents API](https://docs.github.com/en/rest/repos/contents), [Git references](https://docs.github.com/en/rest/git/refs), [pull requests](https://docs.github.com/en/rest/pulls/pulls).
