# Presentation walkthrough

Use the completed company application experiment as the main demonstration. It is one synthetic scenario for two isolated customers, not an exact reconstruction of the Capital One incident. Allow about 8–10 minutes for the walkthrough; a new live run has variable model/network latency.

## 1. Check the retained environment

Open Docker Desktop and PowerShell. Do not restart already-running source containers: their deliberately temporary runtime files are in tmpfs.

```powershell
Set-Location C:\Users\shrey\Desktop\digital_twin
$env:PYTHONPATH='ingestion;.'
.\.venv\Scripts\python -m research.company_demo status
docker ps --format "table {{.Names}}\t{{.Status}}"
```

Expect Acme and Globex sources ready, four application containers per company, and four shared control-plane containers. The status helper checks local application health, source identity, runtime files and certificate/access expiry; API admission still requires fresh agent telemetry. The current access credentials expire **31 October 2026 at 19:51 IST**. If runtime files disappeared after restarting Docker or credentials/certificates expired, use the fresh-demo instructions below before presenting a new live run.

If only the control plane is stopped, start its existing containers without rebuilding:

```powershell
docker compose -p company-path-e7f65303f6 -f .tools/company-path-e7f65303f6/compose.json up -d --wait
```

This restores the dashboard/history; it does not reconstruct lost source tmpfs files.

## 2. Sign in to Acme

Privately copy its issued credential; it is not a username/password account:

```powershell
$access = Get-Content .tools/company-path-e7f65303f6/access.json -Raw | ConvertFrom-Json
Set-Clipboard -Value $access.tokens.acme
```

Open <http://localhost:3001/#company>, choose **Use an issued access credential instead**, paste, and sign in. Do this before screen sharing so credentials stay private.

Say: “These are two synthetic customer environments on my laptop. The employee client is assumed compromised and holds only an employee credential.”

## 3. Show actual discovery

Open **Hosts**, then **3D Twin**. Show Acme's employee, gateway, API and database hosts; agent component nodes may also appear. Explain that agents report running workloads and observed connections. Open **Attack paths** to distinguish candidate paths from executed findings.

Say: “Telemetry discovers topology. Deployment artifacts supply the application images and configuration needed to reproduce behavior.”

## 4. Show the completed attack and repair

Open **Company validation** and select Acme's completed run starting **cc9922cc**.

Point to the discovered path and **Executed attack evidence**. The employee ordinary request succeeds; the restricted request also succeeds with **HTTP 200**, demonstrating the seeded authorization defect. Expand the evidence to show the request identity correlated through the gateway, API and database audit.

Point to **Proposed change and retest**: the internal API policy changes from `authentication_only` to `enforced` in a separate complete candidate. The employee restricted request now returns **HTTP 403**. The same application images were used.

Show all three legitimate workflows passing: employee ordinary read, administrator ordinary read, administrator restricted read. Administrator probes run in a trusted context, not in the compromised employee client.

Say: “A fix passes only if it blocks the attack and preserves permitted use. The source application was not patched.”

Expand **Hunter decisions and executed observations** to show model decisions, actual tool results and verified trace integrity. Use **Evidence JSON** to download the result. Explain that these are saved results of executed live Gemini calls, not a new run happening while you browse them. Temporary verification copies were cleaned up after their tests.

## 5. Show the second customer

Use a separate browser profile or private window so its session is independent. Copy Globex's credential privately:

```powershell
Set-Clipboard -Value $access.tokens.globex
```

Sign in using the same URL. Its workspace lists Globex hosts and results, not Acme's. Select completed run **28d0024c** and show the same 200 → 403 result and passing workflows. Earlier failed attempts remain visible; choose the completed run explicitly.

The independent cross-tenant network, credential, tool-target and API denial checks are in `research/results/company-path-milestone.json`, with raw evidence references. Also show its negative controls: an ineffective repair is rejected, and a deny-all repair is rejected because business workflows fail. Switching workspaces alone is a UI demonstration; these independent checks supply the isolation evidence.

## 6. Optional new live run

Keep Docker and OmniRoute running. The configured local model gateway is `http://127.0.0.1:20128/v1`, using the `lynx-harness` combo with the expected Gemini upstream. Use an OmniRoute API key, not the dashboard's Acme/Globex sign-in token.

In a second PowerShell terminal:

```powershell
Set-Location C:\Users\shrey\Desktop\digital_twin
$env:PYTHONPATH='ingestion;.'
.\.venv\Scripts\python -m research.company_demo worker
```

Enter the OmniRoute key at the hidden prompt before presenting. Keep that terminal open. In Acme's **Company validation** page, select its deployment and click **Validate on disposable copies** once. The page polls automatically. Watch the new run move from queued to running and then completed or failed. The helper handles one job and exits. Never describe a failed or still-running job as a completed validation. The two saved completed runs remain the fallback if the live provider times out.

## After a reboot or expired demo: fresh deployment

First retain the saved JSON/traces, which are already in `research/results`. The following cleanup removes the exact old synthetic project, including its local dashboard database history; it does not delete those saved report files. Run it only when choosing to replace the old demo:

```powershell
$env:PYTHONPATH='ingestion;.'
.\.venv\Scripts\python -m research.company_path_acceptance --cleanup research/results/company-path-e7f65303f6.json
```

With Docker and OmniRoute running, rebuild the UI and launch fresh sources and real Gemini runs using cached images. No image rebuild or Go image download is necessary:

```powershell
npm.cmd --prefix ui run build
$env:TWIN_MODEL_BACKEND='omniroute'
.\.venv\Scripts\python -c "import getpass,os,runpy,sys; os.environ['TWIN_MODEL_API_KEY']=getpass.getpass('OmniRoute API key (hidden): '); sys.argv=['research.company_path_acceptance','--no-build','--keep']; runpy.run_module('research.company_path_acceptance',run_name='__main__')"
```

Run this ahead of the presentation. The runner prints a new report filename; use its new project/access file and completed run IDs instead of the old ones above. For its status/worker helper, append `--report research/results/<new-report>.json`. Each fresh fixture has a 24-hour credential/certificate lifetime. A failed run is recorded honestly and can be retried; avoid last-minute rebuilds during the presentation.

## Closing statement

“We demonstrated discover → reproduce → attack → fix → retest for one application across two isolated tenants. The repair is verified against security and business tests. Our next step is credential-hopping scenarios and validation of defender alerts.”
