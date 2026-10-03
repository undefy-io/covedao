#!/usr/bin/env python3
"""Publish byte-identical CRC runtime sources to the standalone Guardian checkout.

The covedao sources remain authoritative. Guardian package build metadata changes
only to fit its repository layout and exclude covedao's fixture-based test suites.
Shared non-CRC schema definitions and the user's README are never overwritten.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("target", type=Path)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
TARGET = args.target.resolve()
if json.loads((TARGET / "package.json").read_text()).get("name") != "cove-guardian-service":
    raise SystemExit("target must be the standalone Guardian repository")
files = {}

def put(relative, content):
    path = TARGET / relative
    encoded = content if isinstance(content, bytes) else content.encode()
    if args.check:
        if not path.exists() or path.read_bytes() != encoded:
            raise SystemExit(f"Guardian source differs: {relative}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
    files[str(relative)] = hashlib.sha256(encoded).hexdigest()

for package, source in [
    ("crc20-protocol", ROOT / "packages/cove-market/crc20-protocol"),
    ("crc20-adapters", ROOT / "packages/crc20-adapters"),
    ("crc20-state", ROOT / "packages/crc20-state"),
    ("crc20-guardian", ROOT / "packages/crc20-guardian"),
]:
    destination = Path("packages") / package
    for path in source.rglob("*"):
        if any(part in {"node_modules", "dist", ".regtest"} for part in path.relative_to(source).parts):
            continue
        if path.is_file() and (path.suffix in {".ts", ".mjs"} or (path.name.startswith("tsconfig") and path.suffix == ".json")) and ".test." not in path.name and "test-support" not in path.parts:
            relative = path.relative_to(source)
            content = path.read_text()
            if package == "crc20-protocol" and path.name.startswith("tsconfig"):
                content = content.replace("../../../tsconfig.base.json", "../../tsconfig.base.json")
            put(destination / relative, content)
    metadata = json.loads((source / "package.json").read_text())
    if package == "crc20-protocol":
        metadata["scripts"]["typecheck"] = "tsc -p tsconfig.build.json --noEmit"
        metadata["scripts"]["lint"] = "eslint *.ts *.mjs --max-warnings=0 --no-warn-ignored"
        metadata["scripts"].pop("test")
    for unused in ["@playwright/test", "vitest"]:
        metadata.get("devDependencies", {}).pop(unused, None)
    if package == "crc20-protocol":
        for unused in ["bitcoinjs-lib", "ecpair"]:
            metadata.get("devDependencies", {}).pop(unused, None)
    if package == "crc20-adapters":
        metadata.get("devDependencies", {}).pop("tiny-secp256k1", None)
    if package == "crc20-guardian":
        metadata["scripts"].pop("test")
        metadata["devDependencies"].pop("@crclaunch/cove-indexer", None)
        metadata["devDependencies"].pop("@crclaunch/cove-guardian", None)
    put(destination / "package.json", json.dumps(metadata, indent=2) + "\n")

# App, worker and Guardian must share the same cross-process RPC scheduler.
put(Path("packages/db/src/quotas.ts"), (ROOT / "packages/db/src/quotas.ts").read_bytes())

schema_start = "/** Single-core CRC state."
canonical_schema = (ROOT / "packages/db/src/schema.ts").read_text()
suffix = canonical_schema[canonical_schema.index(schema_start):]
existing = (TARGET / "packages/db/src/schema.ts").read_text()
prefix = existing.split(schema_start)[0].rstrip()
if "export const coveCrcAssets" in prefix:
    start = prefix.index("export const coveCrcAssets")
    end = prefix.index("// ── Cove V3 P2P marketplace", start)
    prefix = prefix[:start] + prefix[end:]
put(Path("packages/db/src/schema.ts"), prefix + "\n\n" + suffix)
source_journal = json.loads((ROOT / "packages/db/drizzle/meta/_journal.json").read_text())
target_journal = json.loads((TARGET / "packages/db/drizzle/meta/_journal.json").read_text())
for entry in source_journal["entries"]:
    if entry["tag"] not in {"0038_crc_shared_core", "0039_crc_guardian_journal", "0040_crc_api", "0041_crc_fresh_reset"}:
        continue
    matches = [item for item in target_journal["entries"] if item["idx"] == entry["idx"]]
    if matches and matches[0] != entry:
        raise SystemExit("Guardian migration journal conflicts with canonical CRC migration")
    if not matches:
        target_journal["entries"].append(entry)
    path = Path("packages/db/drizzle") / (entry["tag"] + ".sql")
    put(path, (ROOT / path).read_bytes())
    snapshot = Path("packages/db/drizzle/meta") / f'{entry["idx"]:04d}_snapshot.json'
    put(snapshot, (ROOT / snapshot).read_bytes())
put(Path("packages/db/drizzle/meta/_journal.json"), json.dumps(target_journal, indent=2) + "\n")
manifest = {"authority": "covedao/packages/cove-market/crc20-protocol", "files": files}
put(Path("crc-core-source-manifest.json"), json.dumps(manifest, indent=2) + "\n")
print(f'{"Checked" if args.check else "Synced"} {len(files)} files; source hashes recorded in crc-core-source-manifest.json')
