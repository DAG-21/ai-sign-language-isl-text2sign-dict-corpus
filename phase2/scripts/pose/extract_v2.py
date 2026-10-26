"""MediaPipe landmark extraction with optional accuracy improvements, for comparison against the plain Holistic baseline.

    python extract_v2.py --out OUTDIR [--crop] [--roi] [--smooth] clip1.mp4 clip2.mp4 ...

  --crop    run Holistic on a crop around the signer (the signer fills ~1/3 of a 1080p frame, the pose detector sees 256px)
  --roi     re-run the hand model on a tight, upscaled crop around each pose wrist; used where it finds a hand
  --filter  drop hands whose wrist is implausibly far from the pose model's wrist
  --despike with --smooth: drop frames whose hand jumps away from its neighbours before filling
  --smooth  fill gaps of <= 4 frames and Savitzky-Golay smooth each continuous run (filled frames are flagged)

All coordinates are normalised to the FULL frame (x, y in 0..1; z in the same units as x). The .npz holds:
    pose (T,33,4), pose_world (T,33,4), face (T,468,3)
    left_hand, right_hand (T,21,3)          final (after --smooth if given), NaN where no hand
    left_hand_raw, right_hand_raw           before gap filling and smoothing
    left_world, right_world (T,21,3)        metric hand-local landmarks, only where --roi supplied the hand
    src_left, src_right (T,)                0 none, 1 Holistic, 2 ROI hand model, 3 filled by interpolation
    fps, size (W,H), crop (x0,y0,x1,y1)
"""
import argparse
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from scipy.signal import savgol_filter

mp_h = mp.solutions.holistic
mp_hands = mp.solutions.hands
L_ELB, R_ELB, L_WR, R_WR = 13, 14, 15, 16  # pose indices; "left" is the signer's left


def to_array(landmarks, n, width=3):
    out = np.full((n, width), np.nan, dtype=np.float32)
    if landmarks is None:
        return out
    for i, lm in enumerate(landmarks.landmark):
        out[i] = (lm.x, lm.y, lm.z, lm.visibility)[:width] if width == 4 else (lm.x, lm.y, lm.z)
    return out


def frames_of(path):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    def gen():
        while True:
            ok, f = cap.read()
            if not ok:
                break
            yield f
        cap.release()

    return gen(), fps, w, h


def remap(a, crop, w, h):
    """crop-normalised -> full-frame-normalised (in place); NaN stays NaN."""
    x0, y0, x1, y1 = crop
    cw, ch = x1 - x0, y1 - y0
    a[..., 0] = (x0 + a[..., 0] * cw) / w
    a[..., 1] = (y0 + a[..., 1] * ch) / h
    a[..., 2] *= cw / w
    return a


def run_holistic(path, crop, complexity=2):
    frames, fps, w, h = frames_of(path)
    x0, y0, x1, y1 = crop or (0, 0, w, h)
    pose, world, lh, rh, face = [], [], [], [], []
    with mp_h.Holistic(model_complexity=complexity, smooth_landmarks=True, refine_face_landmarks=False) as hol:
        for f in frames:
            res = hol.process(cv2.cvtColor(f[y0:y1, x0:x1], cv2.COLOR_BGR2RGB))
            pose.append(to_array(res.pose_landmarks, 33, 4))
            world.append(to_array(res.pose_world_landmarks, 33, 4))
            lh.append(to_array(res.left_hand_landmarks, 21))
            rh.append(to_array(res.right_hand_landmarks, 21))
            face.append(to_array(res.face_landmarks, 468))
    c = (x0, y0, x1, y1)
    pose, lh, rh, face = (remap(np.stack(a), c, w, h) for a in (pose, lh, rh, face))
    return pose, np.stack(world), lh, rh, face, fps, w, h


def signer_crop(pose, w, h):
    ok = pose[..., 3] > 0.5
    xs = pose[..., 0][ok] * w
    lo, hi = np.percentile(xs, 1), np.percentile(xs, 99)
    pad = max(0.4 * (hi - lo), 150)
    return (int(max(0, lo - pad)), 0, int(min(w, hi + pad)), h)


def crop_square(frame, cx, cy, side):
    """side x side crop centred on (cx, cy), grey-padded where it leaves the frame."""
    half = side // 2
    x0, y0 = int(cx) - half, int(cy) - half
    canvas = np.full((side, side, 3), 128, np.uint8)
    h, w = frame.shape[:2]
    sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(w, x0 + side), min(h, y0 + side)
    if sx1 > sx0 and sy1 > sy0:
        canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = frame[sy0:sy1, sx0:sx1]
    return canvas, x0, y0


def roi_hands(frame, pose_f, w, h, model):
    """Tight, upscaled crop around each pose wrist -> {side: (landmarks, world)} in full-frame normalised units."""
    found, used = {}, set()
    for side, el, wr in (("left", L_ELB, L_WR), ("right", R_ELB, R_WR)):
        if np.isnan(pose_f[wr, 0]) or pose_f[wr, 3] < 0.3:
            continue
        wrist, elbow = pose_f[wr, :2] * [w, h], pose_f[el, :2] * [w, h]
        fore = max(np.linalg.norm(wrist - elbow), 60.0)
        centre = wrist + 0.45 * (wrist - elbow)
        side_px = int(np.clip(1.3 * fore, 256, 640))
        crop, ox, oy = crop_square(frame, centre[0], centre[1], side_px)
        res = model.process(cv2.cvtColor(cv2.resize(crop, (512, 512)), cv2.COLOR_BGR2RGB))
        if not res.multi_hand_landmarks:
            continue
        best = None
        for i, hand in enumerate(res.multi_hand_landmarks):
            if i in used:
                continue
            pts = np.array([(l.x, l.y, l.z) for l in hand.landmark], np.float32)
            px = np.stack([ox + pts[:, 0] * side_px, oy + pts[:, 1] * side_px], 1)
            d = np.linalg.norm(px[0] - wrist)
            if d < 0.9 * fore + 20 and (best is None or d < best[0]):
                best = (d, i, px, pts[:, 2] * side_px)
        if best is None:
            continue
        _, i, px, z = best
        used.add(i)
        lm = np.stack([px[:, 0] / w, px[:, 1] / h, z / w], 1)
        world = np.array([(l.x, l.y, l.z) for l in res.multi_hand_world_landmarks[i].landmark], np.float32)
        found[side] = (lm, world)
    return found


def plausible(hand, pose_f, el, wr, w, h):
    """Reject a hand whose wrist is implausibly far from the pose model's wrist (an independent estimate)."""
    if np.isnan(pose_f[wr, 0]) or pose_f[wr, 3] < 0.3:
        return True
    fore = max(np.linalg.norm((pose_f[wr, :2] - pose_f[el, :2]) * [w, h]), 60.0)
    return np.linalg.norm((hand[0, :2] - pose_f[wr, :2]) * [w, h]) < 1.2 * fore + 30


def fill_and_smooth(a, max_gap=4, win=5):
    """a: (T,21,3) with NaN rows. Returns (smoothed, filled_mask)."""
    out, t = a.copy(), np.arange(len(a))
    valid = ~np.isnan(a[:, 0, 0])
    filled = np.zeros(len(a), bool)
    idx = np.flatnonzero(valid)
    for s, e in zip(idx[:-1], idx[1:]):
        if 1 < e - s <= max_gap + 1:
            k = np.arange(s + 1, e)
            for j in range(21):
                for c in range(3):
                    out[k, j, c] = np.interp(k, [s, e], [a[s, j, c], a[e, j, c]])
            filled[k] = True
    present = ~np.isnan(out[:, 0, 0])
    start = None
    for i in range(len(out) + 1):
        if i < len(out) and present[i]:
            start = i if start is None else start
        elif start is not None:
            if i - start >= win:
                out[start:i] = savgol_filter(out[start:i], win, 2, axis=0)
            start = None
    return out, filled


def despike(a, w, h, k=0.6):
    """NaN out frames whose landmarks sit far from the median of the neighbouring frames (a swapped/misplaced detection)."""
    out, T = a.copy(), len(a)
    for t in range(T):
        if np.isnan(a[t, 0, 0]):
            continue
        nb = [a[i] for i in (t - 2, t - 1, t + 1, t + 2) if 0 <= i < T and not np.isnan(a[i, 0, 0])]
        if len(nb) < 2:
            continue
        scale = np.array([w, h, w], np.float32)
        dev = np.abs((a[t] - np.median(np.stack(nb), 0)) * scale).max()
        pts = a[t, :, :2] * [w, h]
        if dev > k * np.linalg.norm(pts.max(0) - pts.min(0)):
            out[t] = np.nan
    return out


def process(clip, out_dir, crop_on, roi_on, smooth_on, filter_on, despike_on, complexity=2):
    pose, world, lh, rh, face, fps, w, h = run_holistic(clip, None, complexity)
    crop = None
    if crop_on:
        crop = signer_crop(pose, w, h)
        pose, world, lh, rh, face, fps, w, h = run_holistic(clip, crop, complexity)

    src = {"left": np.where(np.isnan(lh[:, 0, 0]), 0, 1).astype(np.uint8),
           "right": np.where(np.isnan(rh[:, 0, 0]), 0, 1).astype(np.uint8)}
    hands = {"left": lh.copy(), "right": rh.copy()}
    worlds = {s: np.full((len(pose), 21, 3), np.nan, np.float32) for s in hands}

    if roi_on:
        frames, *_ = frames_of(clip)
        with mp_hands.Hands(static_image_mode=True, max_num_hands=2, model_complexity=1,
                            min_detection_confidence=0.25) as model:
            for t, f in enumerate(frames):
                for side, (lm, wd) in roi_hands(f, pose[t], w, h, model).items():
                    hands[side][t], worlds[side][t], src[side][t] = lm, wd, 2

    for side, el, wr in (("left", L_ELB, L_WR), ("right", R_ELB, R_WR)):
        for t in range(len(pose) if filter_on else 0):
            if src[side][t] and not plausible(hands[side][t], pose[t], el, wr, w, h):
                hands[side][t], worlds[side][t], src[side][t] = np.nan, np.nan, 0

    raw = {s: hands[s].copy() for s in hands}
    final = raw
    if smooth_on:
        final = {}
        for s in hands:
            src_in = despike(raw[s], w, h) if despike_on else raw[s]
            src[s][np.isnan(src_in[:, 0, 0])] = 0
            final[s], filled = fill_and_smooth(src_in)
            src[s][filled] = 3

    np.savez_compressed(out_dir / f"{Path(clip).stem}.npz", pose=pose, pose_world=world, face=face,
                        left_hand=final["left"], right_hand=final["right"],
                        left_hand_raw=raw["left"], right_hand_raw=raw["right"],
                        left_world=worlds["left"], right_world=worlds["right"],
                        src_left=src["left"], src_right=src["right"], fps=fps,
                        size=np.array([w, h]), crop=np.array(crop or (0, 0, w, h)))
    print(f"{Path(clip).stem}: L {np.mean(src['left'] > 0):.0%} R {np.mean(src['right'] > 0):.0%}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--crop", action="store_true")
    ap.add_argument("--roi", action="store_true")
    ap.add_argument("--smooth", action="store_true")
    ap.add_argument("--complexity", type=int, default=2, choices=[0, 1, 2], help="pose model size; 1 is about 2x faster")
    ap.add_argument("--despike", action="store_true", help="with --smooth: drop frames that jump away from their neighbours")
    ap.add_argument("--filter", action="store_true", help="drop hands whose wrist disagrees with the pose wrist")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for c in a.clips:
        process(c, a.out, a.crop, a.roi, a.smooth, a.filter, a.despike, a.complexity)
