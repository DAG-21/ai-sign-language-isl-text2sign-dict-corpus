"""Score extraction variants without ground truth, and build visual audit sheets.

    python evaluate.py --root EVALDIR --clips clips.txt --ref A_base [--sheets N]

EVALDIR holds one sub-directory of .npz files per variant (see extract_v2.py).  Metrics, per variant:
  coverage     share of "active" frames (wrist visible and raised above the hips, judged by the --ref variant's pose)
               in which a hand was returned
  wrist_off    median distance between the hand's wrist and the pose model's wrist, in forearm lengths: two models that
               share no weights agreeing on where the hand is
  far          share of returned hands with wrist_off > 0.5 forearm (likely wrong hand/location)
  jump         share of frame-to-frame steps where a landmark moves more than 0.6 hand-sizes (physically implausible)
  jitter       median second difference of landmarks, in hand-sizes (noise; smoothing lowers it, so read with coverage)
  bone_cv      mean over the 20 hand bones of std/mean of bone length across the clip (should be ~0 for a rigid hand)
All hand-size/bone figures are in pixel space with z scaled like x.
"""
import argparse
from pathlib import Path

import cv2
import numpy as np

BONES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
         (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]
SIDES = (("left", 13, 15, "left_hand"), ("right", 14, 16, "right_hand"))


def px(a, w, h):
    return a * np.array([w, h, w], np.float32)


def active_mask(pose, wr, h_w=None):
    hip_y = np.nanmean(pose[:, [23, 24], 1], axis=1)
    return (pose[:, wr, 3] > 0.5) & (pose[:, wr, 1] < hip_y - 0.03)


def score(d, ref, size):
    w, h = size
    out = {"active": 0, "hit": 0, "off": [], "far": 0, "n": 0, "steps": 0, "jumps": 0, "jit": [], "bone": []}
    for side, el, wr, key in SIDES:
        act = active_mask(ref["pose"], wr)
        hand = d[key]
        have = ~np.isnan(hand[:, 0, 0])
        out["active"] += act.sum()
        out["hit"] += (act & have).sum()
        P = px(hand, w, h)
        size_px = np.array([np.linalg.norm(np.nanmax(p[:, :2], 0) - np.nanmin(p[:, :2], 0)) if ok else np.nan
                            for p, ok in zip(P, have)])
        for t in np.flatnonzero(have):
            pw, pe = d["pose"][t, wr], d["pose"][t, el]
            if np.isnan(pw[0]) or pw[3] < 0.3:
                continue
            fore = max(np.linalg.norm((pw[:2] - pe[:2]) * [w, h]), 60.0)
            off = np.linalg.norm((hand[t, 0, :2] - pw[:2]) * [w, h]) / fore
            out["off"].append(off)
            out["far"] += off > 0.5
            out["n"] += 1
        for t in range(1, len(hand)):
            if have[t] and have[t - 1]:
                out["steps"] += 1
                out["jumps"] += np.abs(P[t] - P[t - 1]).max() > 0.6 * np.nanmean(size_px[[t, t - 1]])
        for t in range(1, len(hand) - 1):
            if have[t - 1] and have[t] and have[t + 1]:
                out["jit"].append(np.linalg.norm(P[t + 1] - 2 * P[t] + P[t - 1], axis=1).mean() / size_px[t])
        runs = np.flatnonzero(have)
        if len(runs) > 8:
            L = np.stack([np.linalg.norm(P[runs][:, b] - P[runs][:, a], axis=1) for a, b in BONES], 1)
            out["bone"].append(np.mean(L.std(0) / L.mean(0)))
    return out


def sheet(root, variant, clips, ref, n, mode, out_png):
    """mode 'hits': random detected active frames; 'misses': active frames with no hand."""
    rng = np.random.default_rng(0)
    items = []
    for clip in clips:
        d = np.load(root / variant / f"{clip.stem}.npz")
        r = np.load(root / ref / f"{clip.stem}.npz")
        for side, el, wr, key in SIDES:
            act = active_mask(r["pose"], wr)
            have = ~np.isnan(d[key][:, 0, 0])
            sel = np.flatnonzero(act & (have if mode == "hits" else ~have))
            items += [(clip, d, side, key, wr, t) for t in sel]
    if not items:
        return 0
    pick = rng.choice(len(items), min(n, len(items)), replace=False)
    tiles = []
    for i in pick:
        clip, d, side, key, wr, t = items[i]
        cap = cv2.VideoCapture(str(clip))
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t))
        ok, img = cap.read()
        cap.release()
        h, w = img.shape[:2]
        hand = d[key][t]
        if np.isnan(hand[0, 0]):
            cx, cy = d["pose"][t, wr, :2] * [w, h]
        else:
            cx, cy = np.nanmean(hand[:, :2], 0) * [w, h]
        if mode == "hits":
            pts = (hand[:, :2] * [w, h]).astype(int)
            for a, b in BONES:
                cv2.line(img, tuple(pts[a]), tuple(pts[b]), (0, 255, 0), 2)
            for q in pts:
                cv2.circle(img, tuple(q), 3, (0, 255, 255), -1)
        half = 170
        pad = cv2.copyMakeBorder(img, half, half, half, half, cv2.BORDER_CONSTANT, value=(128, 128, 128))
        tile = pad[int(cy):int(cy) + 2 * half, int(cx):int(cx) + 2 * half]
        cv2.putText(tile, f"{clip.stem[:10]} {side[0].upper()} f{t}", (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        tiles.append(cv2.resize(tile, (255, 255)))
    cols = 6
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
    cv2.imwrite(str(out_png), np.vstack(rows))
    return len(pick)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--clips", type=Path, required=True)
    ap.add_argument("--ref", default="A_base")
    ap.add_argument("--sheets", type=int, default=0, help="audit sheet size (tiles) per variant; 0 = none")
    ap.add_argument("--variants", nargs="*")
    a = ap.parse_args()
    clips = [Path(l.strip()) for l in a.clips.read_text().splitlines() if l.strip()]
    variants = a.variants or sorted(p.name for p in a.root.iterdir() if p.is_dir())
    print(f"{'variant':<14}{'coverage':>9}{'wrist_off':>10}{'far':>7}{'jump':>8}{'jitter':>8}{'bone_cv':>9}{'hands':>7}")
    for v in variants:
        tot = {"active": 0, "hit": 0, "off": [], "far": 0, "n": 0, "steps": 0, "jumps": 0, "jit": [], "bone": []}
        for clip in clips:
            d, r = np.load(a.root / v / f"{clip.stem}.npz"), np.load(a.root / a.ref / f"{clip.stem}.npz")
            s = score(d, r, tuple(d["size"]) if "size" in d else (1920, 1080))
            for k in ("active", "hit", "far", "n", "steps", "jumps"):
                tot[k] += s[k]
            for k in ("off", "jit", "bone"):
                tot[k] += s[k]
        print(f"{v:<14}{tot['hit'] / tot['active']:>9.0%}{np.median(tot['off']):>10.2f}{tot['far'] / tot['n']:>7.1%}"
              f"{tot['jumps'] / max(tot['steps'], 1):>8.1%}{np.median(tot['jit']):>8.3f}{np.mean(tot['bone']):>9.3f}{tot['n']:>7}")
        if a.sheets:
            for mode in ("hits", "misses"):
                n = sheet(a.root, v, clips, a.ref, a.sheets, mode, a.root / f"sheet_{v}_{mode}.png")
