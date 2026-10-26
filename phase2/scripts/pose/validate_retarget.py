"""Round-trip check of retarget_ybot.py: play a bones.json through the rig's forward kinematics and compare every driven
bone's direction with the landmark direction it was meant to follow.

    python validate_retarget.py --tracks public/lab --landmarks LANDMARK_DIR clip1 clip2 ...

Reports the median / 90th-percentile angular error (degrees) per bone group. It checks the retargeting maths and the
avatar's reach; it says nothing about whether the landmarks themselves are right (that is what evaluate.py is for).
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as R

from retarget_ybot import FLIP, HAND_JOINTS, load_rig, unit


def fk(rig, bones):
    wq, wp = {}, {}
    for i in rig["order"]:
        p = rig["parent"].get(i)
        q = R.from_quat(bones[rig["name"][i]]) if rig["name"][i] in bones else rig["local_q"][i]
        t = np.array(rig["nodes"][i].get("translation", [0, 0, 0]), float)
        if p is None:
            wq[i], wp[i] = q, t
        else:
            wq[i], wp[i] = wq[p] * q, wp[p] + wq[p].apply(t)
    return wp


def angle(a, b):
    return np.degrees(np.arccos(np.clip(np.dot(unit(a), unit(b)), -1, 1)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--tracks", type=Path, required=True)
    ap.add_argument("--landmarks", type=Path, required=True)
    a = ap.parse_args()
    rig = load_rig()
    ix = rig["index"]
    err = {"upper arm": [], "forearm": [], "finger bones": [], "thumb bones": []}
    for clip in a.clips:
        z = np.load(a.landmarks / f"{clip}.npz")
        track = json.loads((a.tracks / f"{clip}.bones.json").read_text())
        W, H = (float(v) for v in z["size"])
        for t, fr in enumerate(track["frames"]):
            wp = fk(rig, fr["bones"])
            P = z["pose_world"][t, :, :3] * FLIP
            for side, sh, el, wr, key in (("Left", 11, 13, 15, "left_hand"), ("Right", 12, 14, 16, "right_hand")):
                if np.isnan(P[[sh, el, wr]]).any():
                    continue
                d = lambda x, y: wp[ix[f"mixamorig{side}{y}"]] - wp[ix[f"mixamorig{side}{x}"]]
                err["upper arm"].append(angle(d("Arm", "ForeArm"), P[el] - P[sh]))
                err["forearm"].append(angle(d("ForeArm", "Hand"), P[wr] - P[el]))
                hl = z[key][t]
                if np.isnan(hl[0, 0]):
                    continue
                L = hl * np.array([W, H, W]) * FLIP
                for finger, base in HAND_JOINTS.items():
                    for k in range(1, 4):
                        e = angle(d(f"Hand{finger}{k}", f"Hand{finger}{k + 1}"), L[base + k] - L[base + k - 1])
                        err["thumb bones" if finger == "Thumb" else "finger bones"].append(e)
    print(f"{'bone group':<14}{'samples':>8}{'median':>9}{'p90':>8}  (degrees)")
    for k, v in err.items():
        print(f"{k:<14}{len(v):>8}{np.median(v):>9.2f}{np.percentile(v, 90):>8.2f}")


if __name__ == "__main__":
    main()
