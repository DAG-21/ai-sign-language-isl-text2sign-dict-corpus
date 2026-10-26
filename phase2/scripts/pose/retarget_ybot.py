"""Turn extracted landmarks (extract_v2.py .npz) into a bone track for the Y Bot avatar (public/models/ybot.glb).

    python retarget_ybot.py --out public/lab clip1.npz clip2.npz ...

Writes <out>/<clip>.bones.json = {fps, frames: [{t, bones: {<three.js bone name>: [x, y, z, w]}}]} of LOCAL quaternions, the
format app/lab/retarget/page.tsx plays (/lab/retarget?clip=<clip>&play=1).

Method:
  * every bone with a target gets an absolute world rotation = shortest-arc(rest direction -> target direction) * rest rotation
  * arms: the signer's palm centre and elbow are mapped into the avatar's proportions (arm-length scale; above the shoulders the
    shoulder->eye height is stretched to the avatar's, so a hand at the chin lands at the avatar's chin), then two-bone IK
    gives the arm directions. --direct skips this and copies bone directions instead (hands then land too low on the face)
  * near the face (fingertips within ~3.5-7 inter-eye distances of the eyes in the image) the fingertips are placed relative
    to the avatar's eyes the way the signer's are relative to theirs, blended out with distance
  * head: orientation from nose/ear points, relative to the clip's first frames (neutral); 35% goes to the neck
  * hands also get roll: a (forward, side, normal) frame from the landmarks is matched to the same frame on the rig
  * half of the wrist roll is moved to the forearm so the skin does not twist at the wrist
  * local = parent_world^-1 * world; bones without a target keep the rest pose (spine, legs, face expression)
Landmark frame -> avatar frame: (x, y, z) -> (x, -y, -z); the signer's left (image right) is the avatar's left (+x).
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as R

GLB = Path(__file__).resolve().parents[2] / "public" / "models" / "ybot.glb"
FLIP = np.array([1.0, -1.0, -1.0])


# ---- rig -------------------------------------------------------------------------------------------------------------
def load_rig():
    b = GLB.read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    nodes = json.loads(b[20:20 + n])["nodes"]
    parent = {c: i for i, nd in enumerate(nodes) for c in nd.get("children", [])}
    name = [nd.get("name", "").replace(":", "") for nd in nodes]
    index = {n: i for i, n in enumerate(name)}
    local_q = [R.from_quat(nd.get("rotation", [0, 0, 0, 1])) for nd in nodes]
    local_t = [np.array(nd.get("translation", [0, 0, 0]), float) for nd in nodes]
    order = []

    def walk(i):
        order.append(i)
        for c in nodes[i].get("children", []):
            walk(c)

    walk(index["Armature"])
    wq, wp = {}, {}
    for i in order:
        p = parent.get(i)
        if p is None:
            wq[i], wp[i] = local_q[i], local_t[i]
        else:
            wq[i] = wq[p] * local_q[i]
            wp[i] = wp[p] + wq[p].apply(local_t[i])  # the rig scale (0.01) is uniform, only directions are used
    return dict(name=name, index=index, parent=parent, local_q=local_q, order=order, rest_q=wq, rest_p=wp, nodes=nodes)


def unit(v):
    return v / (np.linalg.norm(v) + 1e-9)


def arc(a, b):
    """Shortest-arc rotation taking direction a to direction b."""
    a, b = unit(a), unit(b)
    c = np.cross(a, b)
    s, d = np.linalg.norm(c), float(np.dot(a, b))
    if s < 1e-8:
        if d > 0:
            return R.identity()
        axis = unit(np.cross(a, [1, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1, 0]))
        return R.from_rotvec(axis * np.pi)
    return R.from_rotvec(c / s * np.arctan2(s, d))


def frame(f, s):
    f = unit(f)
    n = unit(np.cross(f, s))
    return np.stack([f, np.cross(n, f), n], 1)  # columns


# ---- landmark helpers ------------------------------------------------------------------------------------------------
HAND_JOINTS = {"Thumb": 1, "Index": 5, "Middle": 9, "Ring": 13, "Pinky": 17}  # finger -> landmark of bone "1"


def ik_arm(shoulder, wrist, hint, l1, l2):
    """Two-bone IK: (upper arm, forearm) directions that put the wrist at `wrist` (clamped to reach), elbow toward `hint`."""
    v = wrist - shoulder
    d = np.clip(np.linalg.norm(v), 0.15 * (l1 + l2), 0.999 * (l1 + l2))
    axis = unit(v)
    a = (l1 ** 2 - l2 ** 2 + d ** 2) / (2 * d)
    h = np.sqrt(max(l1 ** 2 - a ** 2, 0.0))
    pole = hint - shoulder
    pole = pole - axis * np.dot(pole, axis)
    pole = unit(pole) if np.linalg.norm(pole) > 1e-6 else unit(np.cross(axis, [1, 0, 0]))
    elbow = shoulder + axis * a + pole * h
    return elbow - shoulder, shoulder + axis * d - elbow


class Proportions:
    """Maps signer points (flipped landmark frame, metres) into the avatar's frame (rig units), anchored at the shoulders."""

    def __init__(self, rig, pw):
        ix, rp = rig["index"], rig["rest_p"]
        g = lambda n: rp[ix["mixamorig" + n]]
        self.l1 = np.linalg.norm(g("LeftForeArm") - g("LeftArm"))
        self.l2 = np.linalg.norm(g("LeftHand") - g("LeftForeArm"))
        self.sh = {"Left": g("LeftArm"), "Right": g("RightArm")}
        self.sh_mid = (self.sh["Left"] + self.sh["Right"]) / 2
        P = pw[:, :, :3] * FLIP
        n = lambda a, b: np.linalg.norm(P[:, a] - P[:, b], axis=1)
        L1 = np.nanmedian(np.r_[n(13, 11), n(14, 12)])
        L2 = np.nanmedian(np.r_[n(15, 13), n(16, 14)])
        self.k = (self.l1 + self.l2) / (L1 + L2)
        face = np.nanmedian(((P[:, 2] + P[:, 5]) / 2 - (P[:, 11] + P[:, 12]) / 2)[:, 1])
        self.up = ((g("LeftEye") + g("RightEye")) / 2 - self.sh_mid)[1] / face

    def __call__(self, p, shoulder_mid):
        d = p - shoulder_mid
        return self.sh_mid + np.array([self.k * d[0], d[1] * (self.up if d[1] > 0 else self.k), self.k * d[2]])


def head_deltas(pw, smooth=7, limit_deg=50.0):
    """Per-frame world rotation of the head relative to its pose in the clip's first frames (None where unknown)."""
    from scipy.signal import savgol_filter

    frames = []
    for t in range(len(pw)):
        P = pw[t, :, :3] * FLIP
        if np.isnan(P[[0, 7, 8]]).any():
            frames.append(None)
            continue
        side = P[7] - P[8]
        frames.append(frame(np.cross(P[0] - (P[7] + P[8]) / 2, side), side))
    valid = [i for i, f in enumerate(frames) if f is not None]
    if len(valid) < 3:
        return [None] * len(pw)
    neutral = R.from_matrix(np.stack([frames[i] for i in valid[:5]])).mean()
    vec = np.zeros((len(pw), 3))
    last = np.zeros(3)
    for i, f in enumerate(frames):
        last = (R.from_matrix(f) * neutral.inv()).as_rotvec() if f is not None else last
        vec[i] = last
    if len(vec) >= smooth:
        vec = savgol_filter(vec, smooth, 2, axis=0)
    lim = np.radians(limit_deg)
    norms = np.linalg.norm(vec, axis=1, keepdims=True)
    vec = np.where(norms > lim, vec / np.maximum(norms, 1e-9) * lim, vec)
    return [R.from_rotvec(v) for v in vec]


FACE_NEAR, FACE_FAR = 3.5, 7.0   # fingertip-to-eyes distance (inter-eye distances) between full and no face anchoring


def tip_offset(side, wq, rq, rp, ix):
    """Where the five fingertips' centroid sits relative to the wrist, given the hand and finger world rotations."""
    hand = ix[f"mixamorig{side}Hand"]
    d_hand = wq[hand] * rq[hand].inv()
    tips = []
    for finger in HAND_JOINTS:
        first = ix[f"mixamorig{side}Hand{finger}1"]
        pos = d_hand.apply(rp[first] - rp[hand])
        for k in range(1, 4):
            bone, child = ix[f"mixamorig{side}Hand{finger}{k}"], ix[f"mixamorig{side}Hand{finger}{k + 1}"]
            pos = pos + (wq[bone] * rq[bone].inv()).apply(rp[child] - rp[bone])
        tips.append(pos)
    return np.mean(tips, axis=0)


def retarget_clip(rig, z, direct=False):
    W, H = (float(v) for v in z["size"])
    sc = np.array([W, H])
    fps = float(z["fps"])
    pw = z["pose_world"]
    nm, ix, rq, rp = rig["name"], rig["index"], rig["rest_q"], rig["rest_p"]
    prop = Proportions(rig, pw)
    head = head_deltas(pw)
    eyes_rest = (rp[ix["mixamorigLeftEye"]] + rp[ix["mixamorigRightEye"]]) / 2
    ipd_a = np.linalg.norm(rp[ix["mixamorigLeftEye"]] - rp[ix["mixamorigRightEye"]])
    neck, head_b = ix["mixamorigNeck"], ix["mixamorigHead"]
    frames = []
    for t in range(len(pw)):
        wq = {}   # computed world rotations
        out = {}
        eyes_a = eyes_rest
        if head[t] is not None:
            wq[neck] = R.from_rotvec(head[t].as_rotvec() * 0.35) * rq[neck]
            wq[head_b] = head[t] * rq[head_b]
            head_pos = rp[neck] + (wq[neck] * rq[neck].inv()).apply(rp[head_b] - rp[neck])
            eyes_a = head_pos + (wq[head_b] * rq[head_b].inv()).apply(eyes_rest - rp[head_b])
        eyes_img = (z["pose"][t, 2, :2] + z["pose"][t, 5, :2]) / 2 * sc
        ipd_img = np.linalg.norm((z["pose"][t, 2, :2] - z["pose"][t, 5, :2]) * sc)

        def aim(bone, child, target):
            bi, ci = ix[bone], ix[child]
            rest = rp[ci] - rp[bi]
            wq[bi] = arc(rest, target) * rq[bi]

        for side, S in (("Left", dict(sh=11, el=13, wr=15, hand="left_hand", pi=(17, 19, 21))),
                        ("Right", dict(sh=12, el=14, wr=16, hand="right_hand", pi=(18, 20, 22)))):
            P = pw[t, :, :3] * FLIP
            if np.isnan(P[[S["sh"], S["el"], S["wr"]]]).any():
                continue
            arm, fore, hand = f"mixamorig{side}Arm", f"mixamorig{side}ForeArm", f"mixamorig{side}Hand"

            # 1. hand and fingers (absolute orientations, independent of where the wrist ends up)
            hl = z[S["hand"]][t]
            have = not np.isnan(hl[0, 0])
            if have:
                L = hl * np.array([W, H, W]) * FLIP
                f_t, s_t = L[9] - L[0], L[5] - L[17]
            else:  # at rest: orientation from the pose model's pinky/index/thumb points
                pk, ind, _ = pw[t, S["pi"], :3] * FLIP
                f_t, s_t = (pk + ind) / 2 - P[S["wr"]], ind - pk
                L = None
            fb = frame(rp[ix[f"mixamorig{side}HandMiddle1"]] - rp[ix[hand]],
                       rp[ix[f"mixamorig{side}HandIndex1"]] - rp[ix[f"mixamorig{side}HandPinky1"]])
            wq[ix[hand]] = R.from_matrix(frame(f_t, s_t) @ fb.T) * rq[ix[hand]]
            for finger, base in HAND_JOINTS.items():
                for k in range(1, 4):
                    bone, child = f"mixamorig{side}Hand{finger}{k}", f"mixamorig{side}Hand{finger}{k + 1}"
                    if have:
                        aim(bone, child, L[base + k] - L[base + k - 1])
                    else:
                        wq[ix[bone]] = wq[ix[hand]] * rq[ix[hand]].inv() * rq[ix[bone]]

            # 2. arm directions
            if direct:
                d_up, d_fore = P[S["el"]] - P[S["sh"]], P[S["wr"]] - P[S["el"]]
            else:
                # shoulder-anchored target for the palm centre, then step back to the wrist
                sm = (P[11] + P[12]) / 2
                palm = (P[S["wr"]] + P[S["pi"][0]] + P[S["pi"][1]]) / 3
                wrist_a = prop(palm, sm) - prop.k * (palm - P[S["wr"]])
                if have and ipd_img > 1 and not np.isnan(eyes_img[0]):
                    # near the face, place the fingertips relative to the eyes the way the signer's are (image space)
                    v = (hl[[4, 8, 12, 16, 20], :2].mean(axis=0) * sc - eyes_img) / ipd_img
                    v[1] = -v[1]
                    w = float(np.clip((FACE_FAR - np.linalg.norm(v)) / (FACE_FAR - FACE_NEAR), 0, 1))
                    if w > 0:
                        off = tip_offset(side, wq, rq, rp, ix)
                        face_xy = eyes_a[:2] + v * ipd_a - off[:2]
                        wrist_a = np.array([(1 - w) * wrist_a[0] + w * face_xy[0],
                                            (1 - w) * wrist_a[1] + w * face_xy[1], wrist_a[2]])
                d_up, d_fore = ik_arm(prop.sh[side], wrist_a, prop(P[S["el"]], sm), prop.l1, prop.l2)
            aim(arm, fore, d_up)
            aim(fore, hand, d_fore)

            # 3. move half of the wrist roll to the forearm
            fi, hi = ix[fore], ix[hand]
            axis_local = rq[fi].inv().apply(unit(rp[hi] - rp[fi]))
            q = (wq[fi].inv() * wq[hi]).as_quat()
            proj = np.dot(q[:3], axis_local) * axis_local
            twist = R.from_quat(np.append(proj, q[3])) if np.linalg.norm(np.append(proj, q[3])) > 1e-6 else R.identity()
            wq[fi] = wq[fi] * R.from_rotvec(twist.as_rotvec() * 0.5)

        # local rotations, parents first
        for i in rig["order"]:
            if i in wq:
                p = rig["parent"].get(i)
                pq = wq.get(p, rq[p]) if p is not None else R.identity()
                out[nm[i]] = (pq.inv() * wq[i]).as_quat().round(5).tolist()
        frames.append({"t": round(t / fps, 4), "bones": out})
    return {"fps": fps, "frames": frames}


def hold_missing(track):
    """A bone missing in a frame (no pose that frame) repeats its nearest earlier value, or its first later one at the start."""
    fr = track["frames"]
    for order in (fr, fr[::-1]):          # forward fill, then backward fill for the leading gap
        seen = {}
        for f in order:
            for k, q in f["bones"].items():
                seen[k] = q
            for k, q in seen.items():
                f["bones"].setdefault(k, q)
    return track


def stabilise(track):
    """Keep quaternions on one hemisphere across frames (no 360-degree flips when interpolated)."""
    prev = {}
    for fr in track["frames"]:
        for k, q in fr["bones"].items():
            if k in prev and np.dot(prev[k], q) < 0:
                q = [-v for v in q]
                fr["bones"][k] = q
            prev[k] = q
    return track


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("npz", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--direct", action="store_true", help="copy bone directions instead of mapping into avatar proportions")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    rig = load_rig()
    for f in a.npz:
        track = stabilise(hold_missing(retarget_clip(rig, np.load(f), a.direct)))
        dst = a.out / f"{f.stem}.bones.json"
        dst.write_text(json.dumps(track, separators=(",", ":")))
        print(f"{f.stem}: {len(track['frames'])} frames -> {dst}")
