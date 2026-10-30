"""Check a retained company demo or run its host worker without printing secrets."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import re
import runpy
import sys

import docker
from cryptography import x509

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'worker'])
    parser.add_argument('--report', type=Path,
                        default=ROOT / 'research/results/company-path-e7f65303f6.json')
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding='utf-8'))
    project = report['project']
    if not re.fullmatch(r'company-path-[a-f0-9]{10}', project):
        raise SystemExit('Invalid demo project identifier')
    work = ROOT / '.tools' / project
    auth = json.loads((work / 'auth.json').read_text(encoding='utf-8'))
    expired = any(datetime.fromisoformat(p['expires_at']) <= datetime.now(timezone.utc)
                  for p in auth['principals'])
    print('Dashboard: http://localhost:3001/#company', flush=True)
    print('Sign-in credentials: ' + str(work / 'access.json'), flush=True)
    print('Demo access credentials: ' + ('EXPIRED; create a fresh demo' if expired else 'valid'), flush=True)
    ready = not expired
    client = docker.from_env(timeout=15)
    try:
        for source in report['sources']:
            healthy = True
            for role in ('employee', 'gateway', 'api', 'database'):
                try:
                    container = client.containers.get(f"co-{source['id'][:12]}-{role}")
                    matching = (container.labels.get('digital-twin.company.job') == source['id']
                                and container.labels.get('digital-twin.tenant') == source['tenant_id'])
                    healthy = healthy and matching and container.status == 'running'
                    if matching and container.status == 'running':
                        # Readiness checks only; never print config or key contents.
                        checked = container.exec_run(['sh', '-c',
                            'test -s /run/company/agent.yaml && test -s /run/company/agent.crt'])
                        healthy = healthy and checked.exit_code == 0
                        if role != 'database':
                            checked = container.exec_run(['python', '-c',
                                "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=2).read()"])
                            healthy = healthy and checked.exit_code == 0
                        certificate = container.exec_run(['cat', '/run/company/agent.crt'])
                        healthy = healthy and certificate.exit_code == 0
                        if certificate.exit_code == 0:
                            healthy = healthy and x509.load_pem_x509_certificate(
                                certificate.output).not_valid_after_utc > datetime.now(timezone.utc)
                except docker.errors.NotFound:
                    healthy = False
            ready = ready and healthy
            print(source['tenant_id'] + ': ' + ('sources ready' if healthy else 'sources need a fresh demo'), flush=True)
    finally:
        client.close()
    if args.action == 'status':
        print('Saved completed evidence remains in research/results/company-path-milestone.json')
        return
    if not ready:
        raise SystemExit('Create a fresh demo before starting a live worker; see docs/demo-walkthrough.md')
    composition = json.loads((work / 'compose.json').read_text(encoding='utf-8'))
    environment = composition['services']['ingestion']['environment']
    os.environ['DATABASE_URL'] = environment['DATABASE_URL'].replace('@postgres:5432/', '@127.0.0.1:15432/')
    os.environ['NEO4J_URI'] = 'bolt://127.0.0.1:17687'
    os.environ['NEO4J_USER'] = 'neo4j'
    os.environ['NEO4J_PASSWORD'] = environment['NEO4J_PASSWORD']
    os.environ['TWIN_MODEL_BACKEND'] = 'omniroute'
    if not os.environ.get('TWIN_MODEL_API_KEY'):
        os.environ['TWIN_MODEL_API_KEY'] = getpass.getpass('OmniRoute API key (hidden): ')
    if not os.environ['TWIN_MODEL_API_KEY'].strip():
        raise SystemExit('An OmniRoute API key is required for a real Gemini run')
    print('Worker ready for one queued job. Keep this terminal open; queue a run in Company validation.', flush=True)
    sys.argv = ['twin_ingestion.company.worker', '--catalog', str(work / 'catalog.json'),
                '--max-jobs', '1', '--traces', str(ROOT / 'research/results' / (project + '-demo-traces'))]
    runpy.run_module('twin_ingestion.company.worker', run_name='__main__')


if __name__ == '__main__':
    main()
