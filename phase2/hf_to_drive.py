# Copy the ISLRTC dictionary (Hugging Face re-encode) straight into your Google Drive, from inside Google Colab.
# Nothing passes through your laptop. Run it in a Colab notebook (CPU runtime is fine), one cell at a time or as a whole:
#
#   !pip -q install -U huggingface_hub
#   from google.colab import drive; drive.mount('/content/drive')
#   %run hf_to_drive.py            # after uploading this file to Colab, or paste the file into a cell
#
# Start with DRY_RUN = True: it only lists the files and compares the total size with your free Drive space.
# Then set DRY_RUN = False. The script is resumable: re-run it after a disconnect and it skips finished files.
#
# Source (from the project's own docs): Hugging Face dataset silentone0725/Indian_Sign_Language_Data.gov_Rencoded,
# a re-encode of ISLRTC's Indian Sign Language Dictionary (data.gov.in). The dataset card asks you to cite both the
# original dataset and the re-encode, and to use it ethically. I have not been able to inspect the repo's layout,
# so this script lists it first and keeps the same relative paths on Drive (the manifest's rel_path values depend on that).

import errno
import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.hf_api import RepoFile

REPO_ID = "silentone0725/Indian_Sign_Language_Data.gov_Rencoded"
DEST = "/content/drive/MyDrive/islrtc"   # where the dataset ends up on Drive
TMP = "/content/hf_tmp"                  # local scratch space, emptied file by file
WORKERS = 4                              # parallel downloads; lower it if you see rate-limit errors
TIME_LIMIT_S = 11 * 3600                 # stop starting new files after this (Colab sessions end after about 12 h)
HF_TOKEN = None                          # only needed if the repo turns out to be gated
DRY_RUN = True                           # True = list and check space only; False = actually copy

assert os.path.isdir("/content/drive/MyDrive"), "Mount Drive first: from google.colab import drive; drive.mount('/content/drive')"

api = HfApi(token=HF_TOKEN)
files = [e for e in api.list_repo_tree(REPO_ID, repo_type="dataset", recursive=True) if isinstance(e, RepoFile)]
total = sum(f.size or 0 for f in files)
print(f"{len(files)} files, {total / 1e9:.1f} GB in {REPO_ID}")
by_ext = {}
for f in files:
    by_ext.setdefault(os.path.splitext(f.path)[1].lower() or "(none)", []).append(f)
for ext, items in sorted(by_ext.items(), key=lambda kv: -len(kv[1])):
    print(f"  {ext:8} {len(items):6} files  {sum(i.size or 0 for i in items) / 1e9:.1f} GB   e.g. {items[0].path}")

already = sum(1 for f in files if os.path.exists(os.path.join(DEST, f.path)) and os.path.getsize(os.path.join(DEST, f.path)) == f.size)
remaining = total - sum(f.size or 0 for f in files if os.path.exists(os.path.join(DEST, f.path)) and os.path.getsize(os.path.join(DEST, f.path)) == f.size)
usage = shutil.disk_usage("/content/drive/MyDrive")
print(f"\nalready on Drive: {already} files; still to copy: {remaining / 1e9:.1f} GB")
print(f"Drive reports free space: {usage.free / 1e9:.1f} GB (if this looks wrong, check https://drive.google.com/settings/storage)")
print(f"Colab local disk free: {shutil.disk_usage('/content').free / 1e9:.1f} GB (only a few files are held at a time)")
if remaining > usage.free:
    print("WARNING: the dataset does not fit in your free Drive space. A free Google account has 15 GB; you need a larger Google One plan "
          "or must copy only part of the files (filter `files` above).")

if DRY_RUN:
    print("\nDRY_RUN is True: nothing copied. Review the numbers above, then set DRY_RUN = False and run again.")
    raise SystemExit

stop = threading.Event()
deadline = time.time() + TIME_LIMIT_S
done = skipped = failed = deferred = 0
failures = []
lock = threading.Lock()
started = time.time()
bytes_done = 0


def fetch(f):
    dst = os.path.join(DEST, f.path)
    if os.path.exists(dst) and os.path.getsize(dst) == f.size:
        return "skip", 0
    if stop.is_set() or time.time() > deadline:
        return "defer", 0
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    last = None
    for attempt in range(3):
        local = None
        try:
            local = hf_hub_download(REPO_ID, f.path, repo_type="dataset", local_dir=TMP, token=HF_TOKEN)
            part = dst + ".part"
            shutil.copyfile(local, part)
            if os.path.getsize(part) != f.size:
                raise IOError(f"size mismatch for {f.path}: {os.path.getsize(part)} != {f.size}")
            os.replace(part, dst)
            return "ok", f.size
        except OSError as e:
            if e.errno == errno.ENOSPC:       # Drive or local disk full: stop everything, retrying will not help
                stop.set()
                raise
            last = e
        except Exception as e:                # network / HF errors: back off and retry
            last = e
        finally:
            if local and os.path.exists(local):
                os.remove(local)
        time.sleep(5 * (attempt + 1))
    raise last


# remove half-written copies from an earlier interrupted run
for root, _, names in os.walk(DEST):
    for n in names:
        if n.endswith(".part"):
            os.remove(os.path.join(root, n))

with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    futures = {pool.submit(fetch, f): f for f in files}
    for i, fut in enumerate(as_completed(futures), 1):
        f = futures[fut]
        try:
            status, size = fut.result()
        except Exception as e:
            status, size = "fail", 0
            failures.append((f.path, repr(e)))
        with lock:
            bytes_done += size
            done += status == "ok"
            skipped += status == "skip"
            deferred += status == "defer"
            failed += status == "fail"
        if i % 100 == 0 or i == len(files):
            rate = bytes_done / max(time.time() - started, 1) / 1e6
            print(f"[{i}/{len(files)}] copied {done}, skipped {skipped}, deferred {deferred}, failed {failed}, {bytes_done / 1e9:.1f} GB at {rate:.1f} MB/s")

shutil.rmtree(TMP, ignore_errors=True)

# final check against the repo listing
present = sum(1 for f in files if os.path.exists(os.path.join(DEST, f.path)) and os.path.getsize(os.path.join(DEST, f.path)) == f.size)
print(f"\n{present}/{len(files)} files are on Drive with the right size.")
if failures:
    print("Failures (re-run the script to retry them):")
    for path, err in failures[:20]:
        print("  ", path, err)
if present < len(files):
    print("Not finished: run the script again (it resumes) until it reports all files present.")
