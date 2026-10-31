# Larkspur vulnerable shop

A deliberately vulnerable order-history API for the Digital Twin codebase workflow. Every order and identity is synthetic. This standalone project recreates the authentication issue in the shop scenario; it is not a copy of the running AWS deployment. Run it on localhost for the lab.

## Run

Requires Python 3.11 or newer. No third-party packages are needed.

```sh
python app.py
```

Open http://127.0.0.1:8083/orders. The vulnerable version returns records for multiple customers without authentication (CWE-306).

## Security tests

```sh
python -m unittest test_security -v
```

Five tests intentionally fail in the vulnerable version. After the TwinHunter repair is merged, all six should pass: anonymous and invalid credentials are denied, customers see only their own orders, a customer_id header cannot impersonate a user, and support retains access.

The fixture identities are `synthetic-alice-token`, `synthetic-bob-token` and `synthetic-support-token`, sent as `Authorization: Bearer TOKEN`. These are public synthetic lab values, not production credentials. The identity provider in auth.py already exists; the vulnerability is that list_orders() fails to use it.

## Upload and connect

1. Create an empty public GitHub repository, for example `larkspur-vulnerable-shop`.
2. Upload every file in this folder to its root, including twinlab.json, app.py and auth.py. Keep the Python files unchanged for the supported repair workflow.
3. In Digital Twin, open **Codebase**, enter `https://github.com/YOUR-ACCOUNT/larkspur-vulnerable-shop`, then select **Connect repository**.
4. Attack analysis is enabled after the repository is verified. The scan keeps its three-minute walkthrough and red path replay.
5. **Fix now** creates a branch and pull request with the actual authentication and customer-isolation repair. Repository write access must be configured for the workspace first.
6. Review the diff and run the security tests, then merge. Use **Refresh source** in Codebase to verify the merged code. A pull request alone does not fix the default branch or deploy anything to AWS.

## References

- https://cwe.mitre.org/data/definitions/306.html
- https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/
