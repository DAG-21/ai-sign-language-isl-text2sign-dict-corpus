"""Feasibility check: run MediaPipe Holistic on ISLRTC clips, save landmarks and a side-by-side overlay video.

    python extract_landmarks.py --out OUTDIR clip1.mp4 clip2.mp4 ...

Per clip it writes:
    <name>.npz         pose (T,33,4) x,y,z,visibility | pose_world (T,33,4) | left_hand, right_hand (T,21,3) | fps
                       (NaN rows where nothing was detected; x,y normalised to the frame, z relative)
    <name>.overlay.mp4 original (left) next to the landmarks drawn on a blank canvas (right)
and prints how often each hand was found and how large it is in pixels, which decides whether extraction is viable.
"""
import argparse
import subprocess
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np

mp_h = mp.solutions.holistic
mp_draw = mp.solutions.drawing_utils
mp_style = mp.solutions.drawing_styles


def to_array(landmarks, n, with_vis=False):
    width = 4 if with_vis else 3
    out = np.full((n, width), np.nan, dtype=np.float32)
    if landmarks is None:
        return out
    for i, lm in enumerate(landmarks.landmark):
        out[i] = (lm.x, lm.y, lm.z, lm.visibility) if with_vis else (lm.x, lm.y, lm.z)
    return out


def hand_px(hand, w, h):
    """Longest side of the hand's bounding box, in source pixels."""
    pts = hand[~np.isnan(hand[:, 0])]
    if len(pts) == 0:
        return np.nan
    return max((pts[:, 0].max() - pts[:, 0].min()) * w, (pts[:, 1].max() - pts[:, 1].min()) * h)


def process(clip: Path, out_dir: Path, complexity: int):
    cap = cv2.VideoCapture(str(clip))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {clip}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = 640 / w
    vw, vh = int(w * scale), int(h * scale)
    raw = out_dir / f"{clip.stem}.overlay.raw.mp4"
    writer = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"mp4v"), fps, (vw * 2, vh))

    pose, world, lh, rh = [], [], [], []
    with mp_h.Holistic(model_complexity=complexity, smooth_landmarks=True, refine_face_landmarks=False) as holistic:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            res = holistic.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            pose.append(to_array(res.pose_landmarks, 33, True))
            world.append(to_array(getattr(res, "pose_world_landmarks", None), 33, True))
            lh.append(to_array(res.left_hand_landmarks, 21))
            rh.append(to_array(res.right_hand_landmarks, 21))

            small = cv2.resize(frame, (vw, vh))
            canvas = np.full_like(small, 245)
            mp_draw.draw_landmarks(canvas, res.pose_landmarks, mp_h.POSE_CONNECTIONS,
                                   mp_style.get_default_pose_landmarks_style())
            for hand in (res.left_hand_landmarks, res.right_hand_landmarks):
                mp_draw.draw_landmarks(canvas, hand, mp_h.HAND_CONNECTIONS,
                                       mp_style.get_default_hand_landmarks_style(),
                                       mp_style.get_default_hand_connections_style())
            writer.write(np.hstack([small, canvas]))
    cap.release()
    writer.release()

    # mp4v is not browser friendly; re-encode to H.264
    final = out_dir / f"{clip.stem}.overlay.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(final)], check=True)
    raw.unlink()

    pose, world, lh, rh = map(np.stack, (pose, world, lh, rh))
    np.savez_compressed(out_dir / f"{clip.stem}.npz", pose=pose, pose_world=world, left_hand=lh, right_hand=rh, fps=fps)

    n = len(pose)
    l_ok, r_ok = ~np.isnan(lh[:, 0, 0]), ~np.isnan(rh[:, 0, 0])
    sizes = [hand_px(x, w, h) for x in np.concatenate([lh[l_ok], rh[r_ok]])] if (l_ok.any() or r_ok.any()) else []
    print(f"{clip.stem}: {w}x{h} @ {fps:.0f}fps, {n} frames | left hand {l_ok.mean():.0%}, right hand {r_ok.mean():.0%}, "
          f"either {(l_ok | r_ok).mean():.0%} | hand size median {np.nanmedian(sizes):.0f}px" if sizes else
          f"{clip.stem}: {w}x{h}, {n} frames | no hands detected")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--complexity", type=int, default=2, choices=[0, 1, 2])
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for c in args.clips:
        process(c, args.out, args.complexity)
