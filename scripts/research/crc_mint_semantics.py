#!/usr/bin/env python3
"""Replay observable CRC mint topology without treating site labels as consensus."""

import json
import sqlite3
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from statistics import median

from crc_corpus_fixtures import marker


ATOMS_PER_DISPLAY_UNIT = 100_000_000


@dataclass(frozen=True)
class MintObservation:
    marker_vout: int
    beneficiary_vout: int
    beneficiary_address: str
    vault_vout: int
    vault_address: str
    output_count: int
    payment_asset_evidence: str
    btc_payment_sats: int | None
    ico_payment_atoms: int | None
    minted_atoms: None = None
    csv_blocks: None = None


def _json_marker(output: dict) -> dict | None:
    return marker(bytes.fromhex(output["script_hex"]))


def _positive_address(output: dict) -> str:
    if output["sats"] <= 0 or not output["core_address"]:
        raise ValueError("expected positive spendable address output")
    return output["core_address"]


def inspect_mint(outputs: list[dict]) -> MintObservation:
    """Identify observed output layout; never calculate supply or maturity here."""
    if len(outputs) not in (4, 6):
        raise ValueError("unrecognized mint output count")
    crc = [(i, value) for i, output in enumerate(outputs)
           if (value := _json_marker(output)) is not None
           and value.get("p") == "crc-20" and value.get("op") == "mint"]
    if len(crc) != 1 or crc[0][1].get("tick") != "LEAF":
        raise ValueError("expected one LEAF CRC mint marker")
    marker_vout, mint_json = crc[0]
    if "amt" in mint_json:
        raise ValueError("archived mint layout does not encode amount")
    if len(outputs) == 6 and marker_vout == 2:
        ico = _json_marker(outputs[0])
        if not ico or any(ico.get(k) != v for k, v in
                          {"p": "ico-20", "op": "transfer", "tick": "LEAF"}.items()):
            raise ValueError("missing observed ICO transfer marker")
        try:
            amount = Decimal(ico["amt"]) * ATOMS_PER_DISPLAY_UNIT
        except (KeyError, ValueError, ArithmeticError) as error:
            raise ValueError("invalid ICO payment label") from error
        if amount != int(amount) or amount <= 0:
            raise ValueError("ICO payment is not positive integer atoms")
        if outputs[1]["sats"] != 546:
            raise ValueError("missing observed ICO carrier")
        beneficiary_vout, vault_vout = 3, 4
        evidence, btc_sats, ico_atoms = "ico-20-transfer", None, int(amount)
    elif len(outputs) == 4 and marker_vout == 0:
        if outputs[1]["sats"] == 330:
            beneficiary_vout, vault_vout = 1, 2
            evidence, btc_sats, ico_atoms = "btc-output", outputs[2]["sats"], None
        elif outputs[2]["sats"] == 330:
            beneficiary_vout, vault_vout = 2, 1
            evidence, btc_sats, ico_atoms = "unknown", None, None
        else:
            raise ValueError("unrecognized four-output mint layout")
    else:
        raise ValueError("unrecognized mint marker position")
    return MintObservation(
        marker_vout, beneficiary_vout, _positive_address(outputs[beneficiary_vout]),
        vault_vout, _positive_address(outputs[vault_vout]), len(outputs), evidence,
        btc_sats, ico_atoms,
    )


def replay_mint_observations(db: sqlite3.Connection) -> dict:
    """Reconcile 812 API labels to independent Core output facts where possible."""
    db.row_factory = sqlite3.Row
    rows = db.execute("SELECT * FROM events WHERE kind='mint' ORDER BY block_height, event_index DESC").fetchall()
    asset_labels, csv_labels, status_labels = Counter(), Counter(), Counter()
    amounts_by_asset = Counter()
    beneficiary_matches = btc_payment_matches = ico_payment_matches = 0
    ordi_payment_unverified = 0
    vault_address = None
    mint_outputs = {}
    chronological = []
    for row in rows:
        outputs = [dict(script_hex=o["script_hex"], sats=o["value_sats"], core_address=o["address"])
                   for o in db.execute("SELECT * FROM outputs WHERE txid=? ORDER BY vout", (row["txid"],))]
        observation = inspect_mint(outputs)
        asset = row["mint_payment_asset"]
        if observation.beneficiary_address != row["mint_beneficiary"] or row["to_address"] != row["mint_beneficiary"]:
            raise ValueError(f"beneficiary mismatch: {row['txid']}")
        beneficiary_matches += 1
        mint_outputs[(row["txid"], observation.beneficiary_vout)] = (row["mint_csv_blocks"], row["block_height"])
        if vault_address is None:
            vault_address = observation.vault_address
        elif observation.vault_address != vault_address:
            raise ValueError(f"vault address mismatch: {row['txid']}")
        if asset == "BTC":
            if observation.payment_asset_evidence != "btc-output" or observation.btc_payment_sats != int(row["mint_payment_amount_atoms"]):
                raise ValueError(f"BTC payment mismatch: {row['txid']}")
            btc_payment_matches += 1
        elif asset == "LEAF":
            if observation.payment_asset_evidence != "ico-20-transfer" or observation.ico_payment_atoms != int(row["mint_payment_amount_atoms"]):
                raise ValueError(f"ICO marker payment mismatch: {row['txid']}")
            ico_payment_matches += 1
        elif asset == "ORDI":
            if observation.payment_asset_evidence != "unknown":
                raise ValueError(f"unexpected ORDI topology: {row['txid']}")
            ordi_payment_unverified += 1
        else:
            raise ValueError(f"unknown site payment label: {asset}")
        asset_labels[asset] += 1
        csv_labels[row["mint_csv_blocks"]] += 1
        status_labels[row["mint_status"]] += 1
        amounts_by_asset[asset] += int(row["amount_atoms"])
        chronological.append((row["block_height"], row["event_index"], asset,
                              row["mint_csv_blocks"], int(row["mint_payment_amount_atoms"]),
                              int(row["amount_atoms"])))
    tiers = {}
    same_block_groups = {}
    cumulative_site_supply = 0
    for height, event_index, asset, csv, payment, minted in chronological:
        tiers.setdefault((asset, csv), []).append((payment, minted, cumulative_site_supply))
        same_block_groups.setdefault((height, asset, csv, payment), set()).add(minted)
        cumulative_site_supply += minted
    # A deliberately simple out-of-sample check. This is not an issuance rule.
    holdout_total = holdout_exact = 0
    naive_curve_holdout_total = naive_curve_holdout_exact = 0
    naive_curve_m_spread = {}
    for samples in tiers.values():
        split = max(1, len(samples) * 3 // 4)
        training, testing = samples[:split], samples[split:]
        if not testing:
            continue
        ratios = sorted(Fraction(minted, payment) for payment, minted, _ in training)
        median_ratio = ratios[len(ratios) // 2]
        for payment, minted, _ in testing:
            predicted = median_ratio * payment
            holdout_exact += int(predicted.numerator // predicted.denominator == minted)
            holdout_total += 1
    # Probe the site's public formula under the simplest possible reading:
    # S is cumulative site-labelled minted supply, m is fixed per payment/CSV
    # tier, and BTC/ORDI points follow the published equivalence. This tests
    # the interpretation; it is never used to allocate tokens.
    for (asset, csv), samples in tiers.items():
        if asset not in ("BTC", "ORDI") or len(samples) < 3:
            continue
        split = max(1, len(samples) * 3 // 4)
        ms = []
        for payment, minted, supply in samples[:split]:
            points = payment / (100_000_000 if asset == "BTC" else 1_000_000_000_000_000_000)
            if asset == "BTC":
                points *= 7000
            start, end = supply / ATOMS_PER_DISPLAY_UNIT, (supply + minted) / ATOMS_PER_DISPLAY_UNIT
            integral = (end ** 2.618 - start ** 2.618) / 2.618
            ms.append(points / integral)
        m = median(ms)
        naive_curve_m_spread[f"{asset}:{csv}"] = max(ms) / min(ms)
        for payment, minted, supply in samples[split:]:
            points = payment / (100_000_000 if asset == "BTC" else 1_000_000_000_000_000_000)
            if asset == "BTC":
                points *= 7000
            start = supply / ATOMS_PER_DISPLAY_UNIT
            predicted = ((start ** 2.618 + points * 2.618 / m) ** (1 / 2.618) - start) * ATOMS_PER_DISPLAY_UNIT
            naive_curve_holdout_exact += int(round(predicted) == minted)
            naive_curve_holdout_total += 1
    revealed_csv_spends = Counter()
    maturity_failures = 0
    for transaction in db.execute("SELECT block_height, raw_json FROM transactions"):
        core = json.loads(transaction["raw_json"])
        for source in core["vin"]:
            mint = mint_outputs.get((source["txid"], source["vout"]))
            if mint is None:
                continue
            csv_label, mint_height = mint
            witness = source.get("txinwitness", [])
            if len(witness) != 3:
                raise ValueError("spent mint carrier lacks revealed Taproot script")
            script = bytes.fromhex(witness[1])
            if len(script) != 73 or script[:1] != b"\x20" or script[33:35] != b"\x75\x02" or script[37:40] != b"\xb2\x75\x20" or script[-1:] != b"\xac":
                raise ValueError("unrecognized revealed CSV script")
            csv_on_chain = int.from_bytes(script[35:37], "little")
            if csv_on_chain != csv_label or source["sequence"] != csv_on_chain:
                raise ValueError("revealed CSV disagrees with site label or spending sequence")
            if transaction["block_height"] - mint_height < csv_on_chain:
                maturity_failures += 1
            revealed_csv_spends[csv_on_chain] += 1
    return {
        "mint_count": len(rows),
        "asset_labels": dict(asset_labels),
        "csv_labels": dict(csv_labels),
        "status_labels": dict(status_labels),
        "beneficiary_matches": beneficiary_matches,
        "btc_payment_matches": btc_payment_matches,
        "ico_payment_matches": ico_payment_matches,
        "ordi_payment_unverified": ordi_payment_unverified,
        "api_minted_atoms_total": sum(amounts_by_asset.values()),
        "minted_atoms_by_asset_label": dict(amounts_by_asset),
        "same_block_same_payment_different_allocation_groups": sum(
            len(amounts) > 1 for amounts in same_block_groups.values()),
        "rate_only_holdout_exact": holdout_exact,
        "rate_only_holdout_total": holdout_total,
        "naive_published_curve_holdout_exact": naive_curve_holdout_exact,
        "naive_published_curve_holdout_total": naive_curve_holdout_total,
        "naive_published_curve_m_spread": naive_curve_m_spread,
        "mint_amounts_on_chain": 0,
        "csv_blocks_in_mint_transactions": 0,
        "revealed_csv_spends": dict(revealed_csv_spends),
        "revealed_csv_maturity_failures": maturity_failures,
        "vault_address": vault_address,
        "limitations": [
            "CRC mint markers contain no minted amount, beneficiary, or CSV duration.",
            "BTC sats and ICO marker amounts corroborate payment labels, not mint allocation formulas.",
            "ORDI payments cannot be established from these raw Bitcoin transactions alone.",
            "CSV is proven only for mint carriers spent inside this archive; 527 still-unspent carriers have unrevealed Taproot scripts.",
            "All 812 minted amounts, including the clamped allocation, are site labels until a deterministic issuance rule is derived.",
            "Same-block identical payment/tier can differ by one atom; block order and cumulative supply may affect rounding, but the rule is not specified on-chain.",
            "A rate-only model trained on the first 75% of each asset/CSV tier fails exact held-out allocations; do not use it as a ledger rule.",
            "The published P=m*S^1.618 integral does not fit when S is read as cumulative observed minted supply and m is fixed per asset/CSV tier; normalization, initial state, multipliers and rounding are unspecified.",
        ],
    }


def main() -> None:
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    database = root / "artifacts/crc-garden/activity-2026-09-30.sqlite"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
        print(json.dumps(replay_mint_observations(db), sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
