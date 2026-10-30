# Larkspur Goods: a mini e-commerce company on AWS

A small, realistic-looking online store (fictional, all data synthetic) built from real software on separate servers, plus a Digital Twin control plane. The agents are **not** pre-installed. You join each server from the dashboard and watch it appear in the 3D twin.

```text
            internet (your IP only)
                  │ :80
          ┌───────▼────────┐        public subnet
          │  shop-web01    │  nginx storefront + synthetic shoppers   (ENTRY)
          └──┬──────────┬──┘
     :8081/2 │          │ :8083                    private subnet
   ┌─────────▼──┐   ┌───▼──────────┐
   │ shop-app01 │   │ shop-orders01│
   │ catalog    │   │ orders       │
   │ cart+redis │   │ payments(mock)│
   └─────────┬──┘   └───┬──────────┘
             │ :5432    │ :5432
          ┌──▼──────────▼──┐
          │   shop-db01    │  PostgreSQL 15: products, 250 customers, orders   (CRITICAL)
          └────────────────┘
   twin-control (public subnet): dashboard :3000, agent telemetry :8443
```

| Server | Software | Realistic weaknesses the twin can flag |
|---|---|---|
| shop-web01 | nginx, Python shopper simulator | `server_tokens on` (version disclosure) |
| shop-app01 | catalog and cart services, Redis 6 | Redis without a password, `protected-mode no` |
| shop-orders01 | orders and payments (mock) services; **full layout only**. In the default compact layout these run on shop-app01 | — |
| shop-db01 | PostgreSQL 15 | reachable from two service tiers |

Synthetic shoppers browse, add to cart and buy every few seconds, so live connections web → app/orders → db exist for the agents to observe. All upstream connections are kept open.

**Cost:** about USD 0.20 per hour (≈ $5/day), mostly the NAT gateway and the control server. Run `down` when finished.

## Steps

### 1. Open AWS CloudShell
In the AWS console, pick your region (top right), then click the CloudShell icon (`>_`, top bar).

### 2. Get the code into CloudShell
```bash
git clone -b claude/vibrant-thompson-4jmvcc https://github.com/poojarishreyas/digital_twin.git
```
```bash
cd digital_twin
```
If the clone asks for a password, the repository is private. In that case, download the branch as a ZIP on your laptop, then use CloudShell **Actions → Upload file**, and run `unzip` and `cd` into it.

### 3. Create everything
Find your public IP by opening <https://checkip.amazonaws.com> in your browser, then run:
```bash
bash deploy/aws/ecommerce/deploy.sh up YOUR.IP.HERE/32
```
This takes about 5 minutes and prints the **Dashboard** and **Storefront** URLs.

### 4. Wait for the software to install (~10 minutes)
```bash
bash deploy/aws/ecommerce/deploy.sh status
```
Repeat until you see the **Setup code**, and each shop host ends with `shop-…01 ready`.

### 5. Open the dashboard and create the company
1. Open the **Dashboard** URL (`http://…:3000`), enter the **setup code**, and create the platform admin.
2. **Platform console → New customer** → name it `Larkspur Goods` → copy the invite link.
3. Open the invite link in a **private window** (Ctrl+Shift+N), create the customer admin account, and you land in the empty Larkspur workspace.

Optional: open the **Storefront** URL to see the live store.

### 6. Join servers one by one (the demo moment)
1. In the Larkspur workspace: **Hosts → Add hosts → Linux** → copy the command.
2. AWS console → **EC2 → Instances** → select `shop-web01` → **Connect → Session Manager → Connect**.
3. Paste the command and press Enter. It ends with "Done. This server will appear in your 3D twin…".
4. Watch **3D Twin**: `shop-web01` appears. Repeat for `shop-app01`, `shop-orders01`, `shop-db01`.

To join all four at once instead: `bash deploy/aws/ecommerce/deploy.sh join '<the command>'`.

### 7. Mark entry and crown jewel
On **Overview**, apply the suggestions, or mark `shop-web01` as **entry** and `shop-db01` as **critical**. **Attack paths** then shows storefront → catalog/orders → customer database.

### 8. Delete everything
```bash
bash deploy/aws/ecommerce/deploy.sh down
```

## Troubleshooting
- **No setup code after 15 min:** connect to `twin-control` with Session Manager and run `sudo tail -50 /var/log/twin-control-setup.log`.
- **A shop host isn't ready:** run `sudo tail -50 /var/log/larkspur-setup.log` on that host.
- **Install command fails to download:** the dashboard must be opened with the `http://<public-ip>:3000` URL that `deploy.sh` prints, because the command uses that address.
- **vCPU limit:** the default **compact** layout uses 8 vCPUs: control, web, app and db servers, with orders and payments running on `shop-app01`. The **full** layout gives orders its own server and needs 10 vCPUs. Use it with `LAYOUT=full bash deploy/aws/ecommerce/deploy.sh up …` after AWS raises your limit (request at Service Quotas → EC2 → "Running On-Demand Standard instances").
- **A failed `up`:** run `up` again. It removes the failed attempt first.
- **The code bundle link expires 6 hours after `up`.** Servers download it at boot, so re-run `up` only if you rebuild servers later.
