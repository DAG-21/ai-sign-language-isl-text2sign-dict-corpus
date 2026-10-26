"""Expand a batch track so /lab/retarget can play it:  python scripts/pose/expand_track.py <asset_id> [name]

Reads data/pose/tracks/<asset_id>.bones.json.gz and writes public/lab/<name>.bones.json (name defaults to the asset id).
Open /lab/retarget?clip=<name>&play=1 afterwards.
"""
import gzip
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
asset = sys.argv[1]
name = sys.argv[2] if len(sys.argv) > 2 else asset
dst = ROOT / "public" / "lab" / f"{name}.bones.json"
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_bytes(gzip.open(ROOT / "data" / "pose" / "tracks" / f"{asset}.bones.json.gz").read())
print(dst)
