#!/usr/bin/env python3
"""Require a complete RustSec and crates.io yanked scan; never accept partial success."""
import concurrent.futures
import json
import subprocess
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'security/artifacts'
REVIEWED = {
    ('RUSTSEC-2025-0141', 'bincode', '1.3.3'),
    ('RUSTSEC-2025-0161', 'libsecp256k1', '0.6.0'),
    ('RUSTSEC-2026-0097', 'rand', '0.7.3'),
}


def validate_advisories(report):
    if report['vulnerabilities']['count']:
        raise ValueError('RustSec vulnerabilities require remediation')
    for warnings in report.get('warnings', {}).values():
        for warning in warnings:
            key = (warning['advisory']['id'], warning['package']['name'], warning['package']['version'])
            if key not in REVIEWED:
                raise ValueError(f'Unreviewed advisory: {key}')


def index_record(content, version):
    for line in content.splitlines():
        record = json.loads(line)
        if record['vers'] == version:
            if not isinstance(record.get('yanked'), bool):
                raise ValueError('Missing yanked status')
            if record['yanked']:
                raise ValueError(f'Yanked dependency: {record.get("name")}@{version}')
            return record
    raise ValueError(f'Version {version} absent from registry response')


def scan_package(package):
    name, version = package['name'], package['version']
    prefix = ('1' if len(name) == 1 else '2' if len(name) == 2 else
              f'3/{name[0]}' if len(name) == 3 else f'{name[:2]}/{name[2:4]}')
    url = f'https://index.crates.io/{prefix}/{name}'
    for attempt in range(1, 4):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'recvfund-dependency-ci/1'})
            with urllib.request.urlopen(request, timeout=30) as response:
                record = index_record(response.read().decode(), version)
            if record['cksum'] != package['checksum']:
                raise ValueError(f'Lockfile checksum differs from registry: {name}@{version}')
            return {'name': name, 'version': version, 'yanked': False, 'attempts': attempt}
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == 3:
                raise RuntimeError(f'Incomplete yanked scan for {name}@{version}: {error}') from error
            time.sleep(attempt)


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # cargo-audit can exit 0 after index timeouts. Its RustSec scan and the
    # independently exhaustive sparse-index scan below are both mandatory.
    audit = subprocess.run(['cargo', 'audit', '--json', '--no-yanked'], cwd=ROOT, capture_output=True, text=True)
    (ARTIFACTS / 'cargo-audit.json').write_text(audit.stdout)
    (ARTIFACTS / 'cargo-audit.stderr.txt').write_text(audit.stderr)
    if audit.returncode:
        raise RuntimeError(f'cargo audit failed: {audit.stderr}')
    validate_advisories(json.loads(audit.stdout))
    packages = tomllib.loads((ROOT / 'Cargo.lock').read_text())['package']
    registry = [p for p in packages if p.get('source', '').startswith('registry+')]
    if any(p['source'] != 'registry+https://github.com/rust-lang/crates.io-index' for p in registry):
        raise ValueError('Unreviewed registry')
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        records = list(pool.map(scan_package, registry))
    (ARTIFACTS / 'yanked.json').write_text(json.dumps({'complete': True, 'packagesChecked': len(records), 'packages': records}, indent=2) + '\n')
    tree = subprocess.check_output(['cargo', 'tree', '--locked', '-i', 'rand@0.7.3', '-e', 'features'], cwd=ROOT, text=True)
    (ARTIFACTS / 'rand-features.txt').write_text(tree)
    if 'rand feature "log"' in tree:
        raise ValueError('Reviewed rand warning conditions changed: log feature enabled')
    print(f'RustSec: no vulnerabilities or unreviewed warnings; yanked scan complete for {len(records)} locked registry packages')


if __name__ == '__main__':
    main()
