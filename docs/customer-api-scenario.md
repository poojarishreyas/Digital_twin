# Exposed customer API scenario (modeled on the 2022 Optus breach)

This scenario reproduces the **attack pattern** publicly reported for the September 2022 Optus data breach, on a disposable synthetic twin:

`anonymous internet client -> public gateway -> customer API -> customer database`

It is not a copy of Optus systems; nobody outside Optus has those. Every service is a small declared fixture, and every customer is generated and visibly marked synthetic (`(synthetic)` names, `.example.invalid` emails, `SYN-DL-…` documents).

## What was publicly reported, and what the twin models

| Public reporting | Twin |
|---|---|
| A customer-data API endpoint was reachable from the internet | `GET /v1/customers/{customer_id}` is forwarded unchanged by the public gateway |
| The endpoint did not require authentication | API policy `open` serves any record to an anonymous caller |
| Customer identifiers were sequential, so records could be enumerated | 40 customers with sequential 7-digit IDs `1000001..1000040` |
| Personal and identity-document data was exposed for up to ~9.8 million customers | Each record holds name, date of birth, email, phone, address and an ID-document number (all synthetic) |

Sources to cite in a presentation: Optus's own media statements of September 2022, and the Australian Communications and Media Authority's 2024 Federal Court proceedings against Optus (which allege that an access-control coding error left the API exposed). Check the current status of those proceedings before quoting them.

## What the run demonstrates

1. **Boundary checks first.** The internet client holds no credential, the gateway holds none, and Docker segmentation allows internet → gateway only (internet → API, internet → database and gateway → database are blocked).
2. **TwinHunter attacks as an anonymous internet client** with three typed tools only:
   - `inspect_config`: the sanitized deployment description.
   - `customer_api_probe` `lookup`: one unauthenticated request for the published sample ID.
   - `customer_api_probe` `enumerate`: a bounded unauthenticated batch over 20 sequential IDs.
   - `customer_api_patch` `require_customer_authorization`: the only allowed repair, and only after exposure was confirmed by executed evidence.

   The model never chooses a URL, an identifier, a credential, SQL or a command. These tools live in a scenario-specific decision schema (`twin_ingestion/customer_api/contracts.py`), so the shared hunter schema and the existing benchmark's token accounting are unchanged.
3. **Exposure is counted only from correlated evidence.** A record counts as exposed only when the returned body exactly matches the seeded row *and* the same request ID appears in the gateway log, the API log and a database `access_audit` row. Model statements, status codes or headers alone confirm nothing.
4. **The repair is verified on a separate complete copy.** The candidate has the same images and network rules, and only the API policy changes to `enforced`: a session is required, customers may read only their own record, and support staff are unchanged. It is accepted only if all of the following hold:
   - the original exposure was confirmed and the original legitimate workflows passed;
   - candidate segmentation and credential boundaries pass;
   - anonymous enumeration now exposes **0** records (HTTP 401, still correlated end to end);
   - a signed-in customer reading a neighbour's record is refused (403), which closes the authenticated variant of the same bug;
   - a signed-in customer can still read their own profile, and support staff can still read customer records.

   Negative controls were run: a deny-all "fix" stops the attacker but breaks legitimate workflows and is **rejected**. A no-op "fix" leaves the exposure and is **rejected**.
5. Containers and networks are removed afterwards. Reports hold record hashes, field names and one masked sample, never whole records or credentials.

## Run it

Prerequisites: Docker and the ingestion Python environment (`pip install -r ingestion/requirements-dev.txt`).

```bash
# Non-AI integration smoke (labeled scripted_smoke_not_ai in the report)
python research/customer_api_demo.py --scripted

# Live Gemini via OmniRoute (the default model condition)
TWIN_MODEL_API_KEY=... python research/customer_api_demo.py
```

`--no-build` reuses an existing `digital-twin/customer-api:1.0.0` image. `--tenant` sets the synthetic tenant (default `acme-telco`). The report and hash-chained trace are written to `research/results/customer-api/`, and a narrated summary is printed:

```text
  -> customer_api_probe enumerate
  <- 20/20 synthetic customer records returned without authentication; verdict confirmed
  -> customer_api_patch require_customer_authorization
  <- candidate repair: verified in the tested customer API twin
     before: 20 records exposed; after: 0 exposed, neighbour read not_reproduced, legitimate workflows pass
```

The committed report in `research/results/customer-api/` is a **scripted** smoke. No live-model result for this scenario has been recorded yet.

## Limitations and next steps

- One declared fixture. It shows the bug class and the repair check, not Optus's real architecture, scale or detection gaps.
- Docker internal-network segmentation is measured; a host, LAN or internet firewall gate is not certified.
- Not yet wired into native-agent discovery admission, the job queue or the dashboard as the connected company scenario is. The runner is standalone.
