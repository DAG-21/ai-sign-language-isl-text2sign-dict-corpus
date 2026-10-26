"""Build a STATIC, recorded demo of the pipeline tester page (for hosting on Vercel or any static host).

Why static: the live tester needs a long-running server, FFmpeg, spaCy and a speech model, which do not fit serverless hosting. This script
runs the REAL backend once and bakes the results into one self-contained page that replays them. Nothing is processed on the hosted site,
it contains no API key, and visitors cannot spend any quota.

    python scripts/build_static_demo.py                    # records (live LLM calls) and writes deploy/public/
    python scripts/build_static_demo.py --from-json f.json # rebuild from a previous recording, no network

The recording takes the YouTube job that already exists in data/jobs (it does not download anything) and the page's three text examples.
Only the first few sentences of the video are included, not the whole transcript.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

PAGE = ROOT / "src" / "isl_gloss" / "webui" / "static" / "index.html"
OUT = ROOT / "deploy" / "public"
SECRET_PATTERNS = [r"gsk_[A-Za-z0-9]{10,}", r"AIza[0-9A-Za-z_\-]{20,}", r"GROQ_API_KEY\s*=", r"GEMINI_API_KEY\s*=", r"[A-Za-z]:\\\\?Users", r"/Users/[a-z]+/", r"dhire"]

SHIM = r"""
(function () {
  "use strict";
  const D = window.__DEMO__;
  const realFetch = window.fetch.bind(window);
  const reply = (obj, status = 200, wait = 0) => new Promise((ok) => setTimeout(() => ok(new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })), wait));
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const videoId = (u) => { const m = String(u).match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : null; };
  let polls = 0;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const path = url.split("?")[0];
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (path === "/api/status") { setTimeout(showPills, 80); return reply(D.status); }
    if (path === "/api/youtube/start") {
      polls = 0;
      if (videoId(body.url) !== D.video.id) return reply({ error: "This is a recorded demo: only the pre-filled video link is available here.", hint: "Press “Use the recorded video link”, or try the “Type text” tab examples. The live tool processes any public link." }, 400);
      return reply({ job_id: D.video.job_id, started: true });
    }
    if (path === "/api/youtube/status") { polls += 1; return reply(D.video.frames[Math.min(polls - 1, D.video.frames.length - 1)], 200, 250); }
    if (path === "/api/analyze" || path === "/api/translate") {
      const rec = body.job_id ? D.video : D.texts[norm(body.text)];
      if (!rec) return reply({ error: "This is a recorded demo: it can only replay its examples.", hint: "Use one of the “Try an example” buttons on the Type text tab. The live tool processes any text." }, 400);
      return reply(path.endsWith("analyze") ? rec.analyze : rec.translate, 200, path.endsWith("analyze") ? 300 : 1800);
    }
    return realFetch(input, init);
  };
  function showPills() {
    const el = document.getElementById("status");
    if (el) el.innerHTML = `<span class="pill ok">Recorded demo</span><span class="pill">real output captured ${D.meta.recorded_on}</span><span class="pill">${D.meta.model} · prompt ${D.meta.prompt} · ${D.meta.reasoning} reasoning · ${D.meta.speech_model}</span>`;
  }
  document.addEventListener("DOMContentLoaded", () => {
    const main = document.querySelector("main"), first = main.querySelector(".banner");
    const b = document.createElement("div");
    b.className = "banner";
    b.innerHTML = "<b>Recorded demo.</b> Everything here is the real output of a live run (captured " + D.meta.recorded_on + "), replayed. Nothing is processed on this site, so only the pre-filled video link and the three text examples work. The live tool accepts any public YouTube link or any text.";
    main.insertBefore(b, first);
    document.getElementById("tab-yt").click();
    document.getElementById("yturl").value = D.video.url;
    const n = document.getElementById("ytsent");
    n.value = D.meta.sentences; n.readOnly = true; n.title = "The recording covers the first " + D.meta.sentences + " sentences.";
    const note = document.getElementById("ytnote");
    note.innerHTML = "Recorded: the first " + D.meta.sentences + " sentences of one public video. <button type=\"button\" id=\"usevideo\" style=\"font-size:12px;padding:2px 8px;margin-left:6px\">Use the recorded video link</button>";
    document.getElementById("usevideo").addEventListener("click", () => { document.getElementById("yturl").value = D.video.url; });
    showPills();
  });
})();
"""


# --------------------------------------------------------------------------------------------------------------------
def examples_from_page(html: str) -> list[str]:
    """The page's own example texts, read from the page so the recording can never drift from what the buttons insert."""
    m = re.search(r"const EXAMPLES = (\[.*?\]);", html, re.S)
    if not m:
        raise ValueError("EXAMPLES not found in the page")
    return json.loads(re.sub(r",\s*\]", "]", m.group(1)))


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def frames_from_status(final: dict) -> list[dict]:
    """Four polling frames that replay how the three steps progressed. Built from the real final status."""
    def frame(states: list[str], running: bool, ready: bool) -> dict:
        f = json.loads(json.dumps(final))
        for step, st in zip(f["steps"], states):
            step["state"] = st
            if st != "done":
                step["detail"] = {}
                step["reused"] = False
        f["running"], f["ready"], f["error"] = running, ready, None
        if not ready:
            f.pop("transcript", None)
        f["progress"] = []
        return f
    return [frame(["running", "pending", "pending"], True, False), frame(["done", "running", "pending"], True, False),
            frame(["done", "done", "running"], True, False), frame(["done", "done", "done"], False, True)]


def build_page(html: str, data: dict) -> str:
    """Inject the recorded data and the replay shim before the page's own script. Pure function."""
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    marker = "<script>\n\"use strict\";"
    if html.count(marker) != 1:
        raise ValueError("could not find the page's main script")
    return html.replace(marker, f"<script>window.__DEMO__ = {payload};</script>\n<script>{SHIM}</script>\n{marker}", 1)


def check_clean(text: str) -> None:
    """Refuse to produce a page containing anything that looks like a key or a local path."""
    for pat in SECRET_PATTERNS:
        m = re.search(pat, text)
        if m:
            raise ValueError(f"the built page contains something that looks private ({pat!r}): {text[max(0, m.start() - 30): m.end() + 30]!r}")


def record(jobs_dir: Path, job_id: str, sentences: int, examples: list[str]) -> dict:
    from isl_gloss.webui import demo
    from isl_gloss.webui.youtube_runner import YouTubeRunner

    status = demo.status(ROOT / ".env")
    runner = YouTubeRunner(jobs_dir)
    final = runner.status(job_id)
    if not final["ready"]:
        raise SystemExit(f"job {job_id} has no finished transcript in {jobs_dir}; run the video in the live page first")
    opts = {"job_id": job_id, "max_sentences": sentences, "use_cache": False}  # fresh LLM calls: honest numbers, nothing served from a cache
    print("recording the video run (live LLM calls)...")
    v_an = demo.analyze(None, opts, jobs_dir)
    v_tr = demo.translate(None, opts, env_file=ROOT / ".env", data_dir=tempfile.mkdtemp(), jobs_dir=jobs_dir)
    if v_tr["llm"]["error"]:
        raise SystemExit(f"the LLM call failed, nothing recorded: {v_tr['llm']['error']}")
    last_end = max((s["time"]["end"] for s in v_an["sentences"] if s.get("time") and s["time"]["end"] is not None), default=0)
    final["transcript"]["segments"] = [g for g in final["transcript"]["segments"] if g["start"] <= last_end + 0.5]  # only the part that is shown
    final["transcript"]["total_segments"] = len(final["transcript"]["segments"])
    texts = {}
    for ex in examples:
        print("recording a text example...")
        an = demo.analyze(ex, {}, jobs_dir)
        tr = demo.translate(ex, {"use_cache": False}, env_file=ROOT / ".env", data_dir=tempfile.mkdtemp(), jobs_dir=jobs_dir)
        if tr["llm"]["error"]:
            raise SystemExit(f"the LLM call failed, nothing recorded: {tr['llm']['error']}")
        texts[norm(ex)] = {"analyze": an, "translate": tr}
    vid = job_id.removeprefix("yt-")
    status.update(llm_key_present=True, spacy_available=True, spacy_problem=None, youtube={"available": True, "missing": []})
    status["versions"] = {k: v for k, v in status["versions"].items() if k != "executable"}
    return {"status": status,
            "video": {"id": vid, "job_id": job_id, "url": f"https://www.youtube.com/watch?v={vid}", "frames": frames_from_status(final), "analyze": v_an, "translate": v_tr},
            "texts": texts,
            "meta": {"recorded_on": datetime.now(timezone.utc).strftime("%d %b %Y"), "prompt": v_tr["llm"]["prompt_version"], "reasoning": v_tr["llm"]["reasoning_effort"],
                     "model": v_tr["llm"]["model"], "speech_model": (final["steps"][2]["detail"] or {}).get("model") or "small.en", "sentences": sentences}}


VERCEL_JSON = {
    "cleanUrls": True,
    "headers": [{"source": "/(.*)", "headers": [
        {"key": "X-Robots-Tag", "value": "noindex, nofollow"}, {"key": "X-Content-Type-Options", "value": "nosniff"},
        {"key": "Referrer-Policy", "value": "no-referrer"},
        {"key": "Content-Security-Policy", "value": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"}]}],
}


def write_site(data: dict, out: Path = OUT) -> Path:
    html = build_page(PAGE.read_text(encoding="utf-8"), data)
    check_clean(html)
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (out / "vercel.json").write_text(json.dumps(VERCEL_JSON, indent=2) + "\n", encoding="utf-8")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--job", default="yt-rYKKSH-4ZB8", help="the finished YouTube job in data/jobs to replay")
    ap.add_argument("--jobs-dir", type=Path, default=ROOT / "data" / "jobs")
    ap.add_argument("--sentences", type=int, default=10)
    ap.add_argument("--from-json", type=Path, help="rebuild from a saved recording instead of recording again")
    ap.add_argument("--save-json", type=Path, default=ROOT / "deploy" / "recording.json")
    args = ap.parse_args(argv)
    if args.from_json:
        data = json.loads(args.from_json.read_text(encoding="utf-8"))
    else:
        data = record(args.jobs_dir, args.job, args.sentences, examples_from_page(PAGE.read_text(encoding="utf-8")))
        check_clean(json.dumps(data))
        args.save_json.parent.mkdir(parents=True, exist_ok=True)
        args.save_json.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    out = write_site(data)
    size = sum(f.stat().st_size for f in out.iterdir())
    print(f"wrote {out} ({size // 1024} KB): index.html, robots.txt, vercel.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
