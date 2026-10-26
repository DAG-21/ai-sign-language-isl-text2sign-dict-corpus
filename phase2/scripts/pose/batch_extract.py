"""Resumable batch runner: ISLRTC clip -> landmarks (.npz) -> avatar bone track (.bones.json).

    python scripts/pose/batch_extract.py --out data/pose --workers 4              # everything, shortest files first
    python scripts/pose/batch_extract.py --out data/pose --sample 100             # benchmark: 100 clips spread over all sizes
    python scripts/pose/batch_extract.py --out data/pose --max-mb 2 --workers 4   # only short clips
    python scripts/pose/batch_extract.py --out data/pose --report                 # progress and time estimate, runs nothing

Speed measures (each one measured in the notes of the extraction work, see evaluate.py):
  * priority order: smallest file first (short words), so useful results arrive early
  * MediaPipe Holistic at model_complexity 1 (about 2x faster than 2, same coverage and precision on 12 clips)
  * every `stride`-th frame only (12.5 fps from 25 fps), landmarks interpolated back to the source rate
  * signing-window trimming: while the hands are down, only the lightweight pose model runs (hands are skipped);
    Holistic starts when a wrist rises above the hips and stops after the hands have been down for a while
  * ffmpeg decodes, deinterlaces (yadif) and drops frames in one pass; clips are copied from Drive by a prefetch thread
  * the process asks Windows not to idle-sleep while it runs (a closed lid still sleeps: set the lid action to do nothing)
  * N worker processes, each with one Holistic and one Pose model reused across clips (never reset: a reset reloads the
    models, about 3.5 s for Holistic, which cost more than the clips themselves)

Layout:  <out>/landmarks/<asset_id>.npz   <out>/tracks/<asset_id>.bones.json.gz   <out>/progress.jsonl
To view a track in /lab/retarget, expand it first:  python scripts/pose/expand_track.py <asset_id> [name]
A clip is done when its progress line says "ok"; rerunning skips those (and "error" ones unless --retry-errors;
"stage_error", a failed copy from Drive, is always retried).
Files are written to a temporary name and renamed, so an interrupted run never leaves a half-written output.
"""
import argparse
import gzip
import json
import multiprocessing as mproc
import os
import shutil
import subprocess
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DRIVE = os.environ.get("ISLRTC_DATA_DIR", "G:/My Drive/islrtc")
REST_AFTER = 4          # processed frames with both wrists down before dropping back to the lightweight model
SRC_ASSETS_KEY = "assets"


# ---- worker ----------------------------------------------------------------------------------------------------------
_W = {}


def init_worker(complexity):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import warnings
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    import mediapipe as mp
    import extract_v2 as ev
    import retarget_ybot as rt

    _W["mp"], _W["ev"], _W["rt"] = mp, ev, rt
    _W["holistic"] = mp.solutions.holistic.Holistic(model_complexity=complexity, smooth_landmarks=True,
                                                    refine_face_landmarks=False)
    _W["pose"] = mp.solutions.pose.Pose(model_complexity=0, smooth_landmarks=True)
    _W["rig"] = rt.load_rig()


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_frames", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = (s["r_frame_rate"].split("/") + ["1"])[:2]
    fps = float(num) / float(den) if float(den) else 25.0
    nb = int(s["nb_frames"]) if str(s.get("nb_frames", "")).isdigit() else None
    return int(s["width"]), int(s["height"]), fps or 25.0, nb


def frames(path, w, h, stride, yadif, max_w=1920):
    """Yield (source_index, RGB frame) for every `stride`-th frame, deinterlaced, at most max_w wide."""
    ow, oh = (w, h) if w <= max_w else (max_w, int(round(h * max_w / w / 2)) * 2)
    vf = (["yadif=0:-1:0"] if yadif else []) + [f"select=not(mod(n\\,{stride}))"] + ([f"scale={ow}:{oh}"] if (ow, oh) != (w, h) else [])
    cmd = ["ffmpeg", "-v", "error", "-threads", "1", "-i", str(path), "-filter_threads", "1", "-vf", ",".join(vf), "-vsync", "0", "-f", "rawvideo",
           "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size, i = ow * oh * 3, 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield i * stride, np.frombuffer(buf, np.uint8).reshape(oh, ow, 3)
            i += 1
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def wrist_raised(pose_lm):
    hip = np.nanmean(pose_lm[[23, 24], 1])
    return any(pose_lm[wr, 3] > 0.5 and pose_lm[wr, 1] < hip + 0.01 for wr in (15, 16))


def upsample(a, n, stride):
    """a holds frames 0, stride, 2*stride, ...; fill the frames in between by linear interpolation (NaN if a neighbour is
    missing) and hold the last value to the end. Returns n frames."""
    out = np.full((n,) + a.shape[1:], np.nan, np.float32)
    idx = np.arange(len(a)) * stride
    keep = idx < n
    out[idx[keep]] = a[keep]
    for k in range(1, stride):
        frac = k / stride
        pos = idx[:-1] + k
        ok = pos < n
        out[pos[ok]] = (a[:-1] * (1 - frac) + a[1:] * frac)[ok]
    if len(a) and idx[-1] < n - 1:
        out[idx[-1] + 1:] = a[-1]
    return out


def work(item, local, cfg):
    """Process one staged clip. Returns a progress record (never raises)."""
    ev, rt, holistic, pose_m = _W["ev"], _W["rt"], _W["holistic"], _W["pose"]
    rec = {"id": item["id"], "label": item["label"], "mb": round(item["size"] / 1e6, 2)}
    t0 = time.time()
    try:
        w, h, fps, nb = probe(local)
        stride = max(1, int(round(fps / cfg["fps"])))
        P, PW, LH, RH, active = [], [], [], [], []
        state, low, n_hol, n_lite, last_src = "rest" if cfg["trim"] else "active", 0, 0, 0, 0
        for src, img in frames(local, w, h, stride, cfg["yadif"]):
            last_src = src
            if state == "rest":
                r = pose_m.process(img)
                lm = ev.to_array(r.pose_landmarks, 33, 4)
                n_lite += 1
                if wrist_raised(lm):
                    state, low = "active", 0
                else:
                    P.append(lm)
                    PW.append(ev.to_array(r.pose_world_landmarks, 33, 4))
                    LH.append(np.full((21, 3), np.nan, np.float32))
                    RH.append(np.full((21, 3), np.nan, np.float32))
                    active.append(False)
                    continue
            r = holistic.process(img)
            n_hol += 1
            lm = ev.to_array(r.pose_landmarks, 33, 4)
            P.append(lm)
            PW.append(ev.to_array(r.pose_world_landmarks, 33, 4))
            LH.append(ev.to_array(r.left_hand_landmarks, 21))
            RH.append(ev.to_array(r.right_hand_landmarks, 21))
            active.append(True)
            if cfg["trim"]:
                low = 0 if wrist_raised(lm) else low + 1
                if low >= REST_AFTER:
                    state = "rest"
        if not P:
            rec.update(status="error", err="no frames decoded")
            return rec
        # frames the stride skipped at the end still belong to the clip
        total = min(nb, last_src + stride) if nb else last_src + stride
        pose, world = (upsample(np.stack(a), total, stride) for a in (P, PW))
        hands = {}
        for name, a in (("left_hand", LH), ("right_hand", RH)):
            full = upsample(np.stack(a), total, stride)
            full, _ = ev.fill_and_smooth(ev.despike(full, w, h))
            hands[name] = full
        act = np.flatnonzero(np.repeat(np.array(active), stride)[:total]) if any(active) else np.array([], int)
        data = {"pose": pose, "pose_world": world, "left_hand": hands["left_hand"], "right_hand": hands["right_hand"],
                "fps": np.float32(fps), "size": np.array([w, h]), "stride": stride}
        rec.update(frames=int(total), stride=stride, holistic=n_hol, lite=n_lite, fps=round(fps, 2), w=w, h=h,
                   window=[int(act[0]), int(act[-1])] if len(act) else None)
        if not np.isfinite(pose[:, 11, 0]).any():
            rec.update(status="no_pose")
            return rec

        track = rt.stabilise(rt.hold_missing(rt.retarget_clip(_W["rig"], data)))
        out = Path(cfg["out"])
        tmp_npz, tmp_js = out / "landmarks" / f"{item['id']}.npz.tmp", out / "tracks" / f"{item['id']}.bones.json.gz.tmp"
        with open(tmp_npz, "wb") as f:
            np.savez_compressed(f, **data)
        with gzip.open(tmp_js, "wt", compresslevel=6) as f:     # tracks are repetitive; gzip cuts them about 5x
            json.dump(track, f, separators=(",", ":"))
        os.replace(tmp_npz, out / "landmarks" / f"{item['id']}.npz")
        os.replace(tmp_js, out / "tracks" / f"{item['id']}.bones.json.gz")
        rec["status"] = "ok"
    except Exception as e:  # keep the batch going; the record says what happened
        rec.update(status="error", err=f"{type(e).__name__}: {e}"[:300])
    finally:
        rec["secs"] = round(time.time() - t0, 2)
    return rec


# ---- scheduling ------------------------------------------------------------------------------------------------------
def load_items(manifest, drive, cache_file):
    """Manifest assets with their file sizes, smallest first. Sizes are cached: stat-ing 13k files on Drive takes minutes."""
    assets = json.loads(Path(manifest).read_text())[SRC_ASSETS_KEY]
    sizes = {}
    if cache_file.exists():
        try:
            c = json.loads(cache_file.read_text())
            if c.get("drive") == str(drive):
                sizes = c["sizes"]
        except (ValueError, KeyError):
            pass
    if not all(a["rel_path"] in sizes for a in assets):
        print("reading file sizes from the dictionary folder (once; cached afterwards)...", flush=True)
        for a in assets:
            if a["rel_path"] not in sizes:
                try:
                    sizes[a["rel_path"]] = (Path(drive) / a["rel_path"]).stat().st_size
                except OSError:
                    sizes[a["rel_path"]] = None       # a handful of manifest names do not match the file on disk
        cache_file.write_text(json.dumps({"drive": str(drive), "sizes": sizes}))
    items = [{"id": a["asset_id"], "label": a["label"], "path": str(Path(drive) / a["rel_path"]), "size": sizes[a["rel_path"]]}
             for a in assets if sizes.get(a["rel_path"])]
    items.sort(key=lambda x: (x["size"], x["id"]))
    return items


def read_progress(path):
    done = {}
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                r = json.loads(line)
                done[r["id"]] = r
            except (ValueError, KeyError):
                pass
    return done


def stage(item, cache, tries=6):
    """Copy a clip from Drive to the local cache. Drive reads can fail for a while after the laptop wakes, so retry."""
    dst = Path(cache) / f"{item['id']}.mp4"
    tmp = dst.with_suffix(".part")
    for attempt in range(tries):
        try:
            shutil.copyfile(item["path"], tmp)
            os.replace(tmp, dst)
            return item, str(dst)
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(10 * (attempt + 1))


def report(items, done, workers):
    ok = [r for r in done.values() if r.get("status") == "ok" and r.get("secs")]
    print(f"{len(items)} clips on disk | done {len(ok)} ok, {sum(r.get('status') == 'error' for r in done.values())} error, "
          f"{sum(r.get('status') == 'no_pose' for r in done.values())} without a person")
    if len(ok) < 5:
        return
    mb = np.array([r["mb"] for r in ok])
    secs = np.array([r["secs"] for r in ok])
    frames = np.array([r["frames"] for r in ok])
    b, a = np.polyfit(mb, secs, 1)
    share = sum(r["holistic"] for r in ok) / sum(r["frames"] / r["stride"] for r in ok)
    print(f"processed so far: {frames.sum()} frames in {secs.sum() / 60:.1f} worker-minutes = "
          f"{secs.sum() / frames.sum() * 1000:.0f} ms of one worker per source frame; "
          f"the full model ran on {share:.0%} of the processed frames (the rest were hands-down frames)")
    print(f"fit: seconds per clip = {a:.1f} + {b:.2f} x MB   (one worker)")
    for name, sel in (("all clips", items), ("clips under 2 MB", [i for i in items if i["size"] < 2e6]),
                      ("clips under 5 MB", [i for i in items if i["size"] < 5e6])):
        total = sum(a + b * i["size"] / 1e6 for i in sel)
        left = sum(a + b * i["size"] / 1e6 for i in sel if i["id"] not in done)
        print(f"  {name:<17}{len(sel):>6} clips: ~{total / workers / 3600:.1f} h total, ~{left / workers / 3600:.1f} h left with {workers} workers")


def keep_awake(on):
    """Ask Windows not to idle-sleep while this process runs (what media players do). A closed lid still sleeps."""
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 if on else 0x80000000)   # ES_CONTINUOUS [| ES_SYSTEM_REQUIRED]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "pose")
    ap.add_argument("--drive", default=DEFAULT_DRIVE)
    ap.add_argument("--manifest", type=Path, default=ROOT / "data" / "islrtc" / "manifest.json")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--complexity", type=int, default=1, choices=[0, 1, 2])
    ap.add_argument("--fps", type=float, default=12.5, help="target processing rate; the stride is round(source_fps / this)")
    ap.add_argument("--no-trim", action="store_true", help="run Holistic on every processed frame")
    ap.add_argument("--no-yadif", action="store_true")
    ap.add_argument("--limit", type=int, help="process at most this many pending clips (priority order)")
    ap.add_argument("--sample", type=int, help="process N clips spread evenly over the size-sorted list (benchmark)")
    ap.add_argument("--max-mb", type=float)
    ap.add_argument("--min-mb", type=float)
    ap.add_argument("--only-paths", type=Path, help="text file of clip paths (one per line); only those are processed")
    ap.add_argument("--retry-errors", action="store_true")
    ap.add_argument("--lookahead", type=int, default=3, help="clips staged ahead per worker")
    ap.add_argument("--min-free-gb", type=float, default=1.0, help="stop cleanly when the output drive has less free space")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()

    for d in ("landmarks", "tracks"):
        (a.out / d).mkdir(parents=True, exist_ok=True)
    progress_path = a.out / "progress.jsonl"
    items = load_items(a.manifest, a.drive, a.out / "sizes.json")
    done = read_progress(progress_path)
    if a.report:
        report(items, done, a.workers)
        return

    pool_items = [i for i in items if (a.min_mb is None or i["size"] >= a.min_mb * 1e6) and (a.max_mb is None or i["size"] <= a.max_mb * 1e6)]
    if a.only_paths:
        want = {Path(l.strip()).as_posix() for l in a.only_paths.read_text().splitlines() if l.strip()}
        pool_items = [i for i in pool_items if Path(i["path"]).as_posix() in want]
    if a.sample:
        pool_items = [pool_items[k] for k in np.unique(np.linspace(0, len(pool_items) - 1, a.sample).astype(int))]
    skip = {"ok", "no_pose"} | (set() if a.retry_errors else {"error"})
    pending = [i for i in pool_items if done.get(i["id"], {}).get("status") not in skip]
    if a.limit:
        pending = pending[:a.limit]
    print(f"{len(items)} clips on disk, {len(pool_items)} selected, {len(pending)} to do, {a.workers} workers, "
          f"complexity {a.complexity}, stride from {a.fps} fps, trim={'off' if a.no_trim else 'on'}", flush=True)
    if not pending:
        return

    keep_awake(True)
    cfg = {"out": str(a.out), "fps": a.fps, "trim": not a.no_trim, "yadif": not a.no_yadif}
    cache = a.out / ".cache"
    shutil.rmtree(cache, ignore_errors=True)
    cache.mkdir()
    copier = ThreadPoolExecutor(max_workers=2)
    window, it = deque(), iter(pending)
    in_flight, finished, t_start = 0, 0, time.time()
    results = deque()

    def top_up():
        while len(window) < a.lookahead * a.workers:
            nxt = next(it, None)
            if nxt is None:
                return
            window.append((nxt, copier.submit(stage, nxt, cache)))

    ctx = mproc.get_context("spawn")
    with ctx.Pool(a.workers, initializer=init_worker, initargs=(a.complexity,)) as pool, open(progress_path, "a") as log:
        def on_done(rec):
            results.append(rec)

        try:
            top_up()
            while window or in_flight:
                while results:
                    rec = results.popleft()
                    in_flight -= 1
                    finished += 1
                    log.write(json.dumps(rec) + "\n")
                    log.flush()
                    (cache / f"{rec['id']}.mp4").unlink(missing_ok=True)
                    if finished % 10 == 0 or finished == len(pending):
                        el = time.time() - t_start
                        print(f"[{finished}/{len(pending)}] {el / 60:.1f} min, {el / finished:.1f} s/clip wall, last: {rec['label']} "
                              f"({rec.get('status')}, {rec.get('secs')} s)", flush=True)
                if shutil.disk_usage(a.out).free < a.min_free_gb * 1e9:
                    print(f"stopping: less than {a.min_free_gb} GB free on the output drive; free space and rerun", flush=True)
                    window.clear()
                    if not in_flight:
                        break
                if window and in_flight < a.workers + 1:
                    item, fut = window.popleft()
                    top_up()
                    in_flight += 1
                    try:
                        local = fut.result()[1]
                    except Exception as e:      # a clip that cannot be read must not stop the batch; it is retried on the next run
                        on_done({"id": item["id"], "label": item["label"], "mb": round(item["size"] / 1e6, 2),
                                 "status": "stage_error", "err": f"{type(e).__name__}: {e}"[:300]})
                        continue
                    pool.apply_async(work, (item, local, cfg), callback=on_done,
                                     error_callback=lambda e, it=item: on_done({"id": it["id"], "label": it["label"], "status": "error", "err": str(e)[:300]}))
                else:
                    time.sleep(0.2)
        except KeyboardInterrupt:
            print("interrupted: finished clips are saved; rerun to continue", flush=True)
            pool.terminate()
    shutil.rmtree(cache, ignore_errors=True)
    keep_awake(False)
    done = read_progress(progress_path)
    print(f"wall time {(time.time() - t_start) / 60:.1f} min")
    report(items, done, a.workers)


if __name__ == "__main__":
    main()
