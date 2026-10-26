# ISLRTC dictionary integration: setup

Status (2026-10-20): the ISLRTC dictionary (HEVC re-encode, 13,665 clips) is indexed by `ai-sign-language/run_islrtc_index.py`; the resolver, plan and media endpoints and the mixed
player in this repo have been run against that real index and real clips. Labels come from **file names only** (the download has no label table) and are unreviewed. See
`ai-sign-language/docs/islrtc_dataset_audit.md` for counts and limits.

## Environment variables (server side)

| Variable | Meaning | Default |
|---|---|---|
| `ISLRTC_DATA_DIR` | Root of the downloaded dictionary. Read in place, never copied or committed. | none (dictionary disabled) |
| `ISLRTC_MANIFEST` | `manifest.json` written by the indexer (schema `lib/sign/types.ts`, `schema_version "1.0"`). Paths inside are relative to `ISLRTC_DATA_DIR`. | `data/islrtc/manifest.json` |
| `ISLRTC_MAPPINGS` | Optional reviewed decisions `{select, alias, split}` (the indexer writes `select` from a review CSV). | `data/islrtc/approved_mappings.json` |
| `ISLRTC_TRANSCODE` | `1` allows `/api/islrtc/<id>?format=h264`: converts that one clip with FFmpeg on first request (720p cap, `veryfast`, about 1 to 2 s per short clip) and caches it. | off |
| `ISLRTC_CACHE_DIR` | Where the H.264 copies go. | `.cache/islrtc` |
| `FFMPEG_PATH` | FFmpeg binary. | `ffmpeg` on PATH |

Example (PowerShell):
```
$env:ISLRTC_DATA_DIR="C:\Dhiren\internship\islrtc"
$env:ISLRTC_MANIFEST="data\islrtc\manifest.json"
$env:ISLRTC_MAPPINGS="data\islrtc\approved_mappings.json"
$env:ISLRTC_TRANSCODE="1"
npm run build; npm start          # then open /demo
```
Without a manifest the app still works: avatar signs and `FS:` fingerspelling play; everything else is shown as unresolved.

## Browser playback of HEVC (verified on real clips)

Chrome on the development PC reports no HEVC support (`canPlayType` empty) and rejects the original clips with `MEDIA_ERR_SRC_NOT_SUPPORTED`. With `ISLRTC_TRANSCODE=1` the player asks for the
H.264 copy straight away (it detects this itself) and warms upcoming conversions when a plan loads; three real clips (`Today`, `World`, `Professor`) then played in Chrome at 1280x720.
Without the flag, dictionary videos will not play in browsers that lack HEVC. Other browsers were not tested. Originals are never modified; only requested clips are converted.

## Endpoints

* `POST /api/sign-plan` `{tokens: string[], fingerspellUnknown?: boolean}` returns `{plan, coverage, dictionaryLoaded}`. Each plan item has `kind` = `yap_animation | islrtc_video | fingerspelling | unresolved`;
  dictionary videos keep the asset id and a `reviewed` flag (false = unreviewed source label).
* `GET|HEAD /api/islrtc/<asset id>`: only ids present in the manifest; ids must match `[A-Za-z0-9_-]{1,64}`; the manifest path must be relative, free of `..`, have an allowed video extension and resolve
  (after symlinks) inside `ISLRTC_DATA_DIR`. Supports `Range` (206/416). Tested with traversal, absolute-path and malformed-id attempts.
* `/lab/retarget?clip=<id>&frame=<n>`: EXPERIMENT only (see `ai-sign-language/docs/islrtc_pose_poc.md`); reads `public/lab/<id>.bones.json` (git-ignored). Not linked from the product UI.

## Resolution rules (lib/sign/resolver.ts)

Yap animation, then ISLRTC video, then fingerspelling (`FS:` names always; other words only if `fingerspellUnknown`), then `unresolved`. Multiword phrases before single words. Exact label, source-provided
alias or reviewed mapping only; **no fuzzy matching.**

**Default sign for alternates.** A headword with several signs (`(Sign_2)` alternates, `(Financial_Term)` senses) gets ONE default chosen by the indexer and stored in `approved_mappings.json`
(`select`, with `auto_default` listing `[chosen, ...alternates]`), so every occurrence of a word shows the same sign, in every sentence and every run. The rule is deterministic: the entry that is the word itself, then a
clean entry over a needs-review one, then no sense qualifier, then the base file, then the lowest `(Sign_N)`, then path. The player shows such items as `default sign (N alternates not shown)`. A reviewer's
`default` decision in `review_queue.csv` always overrides it. This is a consistency rule: it does not claim the chosen sign is the best or only one. Without a mappings file such words stay `unresolved: ambiguous`. `ResolverContext.requireReview` restricts auto-selection to reviewer-approved entries. Known policy conflict: a phrase match runs before single words,
so `I`,`KNOW` matches the dictionary's `I Know` even though Yap has both words as animations; change the order in `resolveGloss` if you prefer the avatar.

## Try it yourself (nothing is committed; this is a local test)

```
cd C:\Dhiren\internship\yap-render
npm run dev:islrtc                  # sets the env vars above and starts the dev server on http://localhost:3000
npm run dev:islrtc -- -Port 3010    # another port
```
Use the npm script rather than running `scripts\dev-islrtc.ps1` directly: on a default Windows setup PowerShell blocks `.ps1` files ("running scripts is disabled on this system"); the npm script starts it with `-ExecutionPolicy Bypass` for that one run only.
Open `http://localhost:3000/demo`: one input box and one output box. Type ISL gloss words (for example `HELLO STUDENT TODAY WORLD PROFESSOR FS:AMIT THANK_YOU`) and press **Sign** (or Enter). The output box signs them in order: the 3D avatar for words it knows, a recorded ISLRTC dictionary video for other dictionary words (a small tag in the corner says which), the avatar spelling letters for `FS:` names; words with no sign are skipped. The home page `/` is the original Yap & Render page and is unchanged. The first play of a clip waits 1 to 2 s for the H.264 conversion. For the word-by-word breakdown of where each sign comes from, call `POST /api/sign-plan` or run `scripts/coverage-report.ts`.

## Synonyms for words with no sign

`approved_mappings.json` also carries a validated synonym table (`synonyms`, built from `ai-sign-language/data/vocab/synonyms.json`; see `ai-sign-language/docs/gloss_signability.md`). When a gloss word has no sign of its own, the resolver tries an available word that means (nearly) the same,
e.g. `HI` is signed as `HELLO`. A word's own sign always wins; the original word is kept and the substitution is reported (`synonym` on the result, `synonyms` counts in the coverage, and a corner tag such as `avatar · HI → HELLO` in the demo). Levels: `exact` (default), `close` (near-synonyms such as `SAY`→`TELL`), `off`.
Set it per request (`POST /api/sign-plan {"synonyms": "close"}`) or in the demo URL: `/demo?synonyms=close` or `/demo?synonyms=off`. The table is unreviewed by an ISL signer.

## Commands

```
npm test          # vitest (78 tests; 3 real-data end-to-end tests skip unless the env below is set; 81 run with it)
npm run typecheck # tsc --noEmit (the production build does NOT type-check: next.config.mjs ignores type errors)
npm run build
# real-data end-to-end + coverage:
$env:PHASE1_GLOSS_DIR="..\phase1\data\translations"; $env:ISLRTC_MANIFEST=...; $env:ISLRTC_MAPPINGS=...; $env:ISLRTC_DATA_DIR=...; npm test
npx vite-node scripts/coverage-report.ts -- --manifest <manifest.json> --gloss <a.gloss.json> --gloss <b.gloss.json> [--require-review] [--fingerspell-unknown] [--synonyms off|exact|close] [--json out.json]
```
This repo has no lint configuration, so there is no lint step.

## Licence / attribution

The project owner has confirmed the dataset may be used for this project (2026-10-20). For reference, the Hugging Face README (`silentone0725/Indian_Sign_Language_Data.gov_Rencoded`) states MIT for the re-encode of
ISLRTC's *Indian Sign Language Dictionary (till January 2024)* from data.gov.in, asks users to cite both the original dataset and the re-encode, and asks for ethical use (no surveillance or profiling). I did not independently
verify the data.gov.in terms. The Y Bot avatar is Mixamo-licensed (`public/models/ATTRIBUTION.md`). The Yap & Render repository itself has no licence file.

## Avatar tracks from the dictionary clips (`islrtc_pose`)

A dictionary clip can be signed by the 3D avatar instead of played as video. `scripts/pose/batch_extract.py` extracts hand and body landmarks from each clip (MediaPipe) and retargets them to the Y Bot rig;
the result is one `data/pose/tracks/<asset id>.bones.json.gz` per clip, plus `landmarks/<asset id>.npz`, `quality.csv` and `progress.jsonl` (git-ignored: `data/pose/`).

| Variable | Meaning | Default |
|---|---|---|
| `ISLRTC_POSE_DIR` | Folder holding `pose_index.json` and `tracks/` | `data/pose` |

1. Score the clips and apply the quality gate (hands in at least 30% of frames, shoulders in at least 90%, a signing window). Writes `data/pose/pose_index.json`:
   `node node_modules/vite-node/vite-node.mjs scripts/build-pose-index.ts -- --dir data/pose` (`--min-hand`, `--min-body` change the thresholds).
2. `POST /api/sign-plan` now returns `kind: "islrtc_pose"` for a dictionary word whose track passed the gate (otherwise `islrtc_video`, as before). `coverage.bySource.islrtc_pose` and `coverage.poseSequence` count them.
3. `GET /api/islrtc-pose/<asset id>` serves the gzipped track (`Content-Encoding: gzip`). Only gated ids are served; anything else is 404 and the player falls back to the video.
4. `AvatarPlayer` takes a `poseRun` prop. A run of signs is one continuous movement: each track is smoothed when loaded (one- and two-frame glitches removed), trimmed to the part where the hands are raised, and cross-faded into the next over 0.25 s while both are still moving. The first sign fades in from wherever the avatar already is (no reset), and the last fades out into the neutral pose that phrases start from. `/demo` uses it. `/demo` shows the "human" avatar (`public/models/Remy.glb`, a Mixamo character with the same skeleton names and T-pose as Y Bot but different bone axes); `AvatarPlayer` converts every rotation, from the hand-made animations and from the tracks, through each bone's rest world rotation. Remy's proportions are close to Y Bot's (arm to eye height and shoulder width within about 5%), which is why the tracks, fitted to Y Bot, still land on his face. To use another Mixamo character: download it as FBX (T-pose, no animation) and run `scripts/convert_fbx_to_glb.py`.

Without `pose_index.json` nothing changes: every dictionary word resolves as its video. A track that passes the gate is still unreviewed: the gate checks coverage, not that the hand shapes read correctly.
Known limits: each sign is trimmed to its signing window but not otherwise reviewed; the torso is not driven; the face is used only for head direction; a Yap animation after a track starts from the neutral pose.

### Following the words in `/demo`

Above the avatar the demo lists the sentence's gloss words, each with how it is signed (hand-made, avatar motion, video, spelled, or no sign). The word being signed is a solid green chip and is also shown as a caption over the avatar; words already signed turn light green with a tick; a word with no sign is a dashed red chip, struck through once it has been passed over; a sign that could not be played is amber. The line under the chips counts the words covered and not covered, how the covered ones are signed, and names the words with no sign. `AvatarPlayer`'s `onWordProgress` reports the token (hand-made phrases) or sign (avatar tracks) being played; `lib/sign/progress.ts` turns that into the chip states.

## Phase 1 and Phase 2 together (`/demo`)

Phase 1 is the Python project in the `phase1` folder (a sibling of this `phase2` folder): transcript cleaning, sentence chunking, context grouping, then the gloss layers (Layer 1 LLM through
Groq `openai/gpt-oss-120b`, Layer 2 spaCy) and the YouTube front end (download, audio, Whisper). Phase 2 is this app: resolve each gloss word to a hand-made
animation, an avatar motion, a dictionary video or fingerspelling, and sign it with the avatar. They are two programs joined over HTTP on this machine.

```
English text ─┐
Video link ───┼─> Phase 1 server (127.0.0.1:8765) ─> gloss per sentence ─> /api/sign-plan (resolver) ─> avatar
Gloss words ──┴──────────────────────────────────────────────────────────┘ (typed gloss skips Phase 1)
```

Start both with one command (Phase 1 opens in its own window; if something already listens on 8765 it is reused):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-all.ps1
# Phase 1 in another place:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-all.ps1 -Phase1Dir "D:\path\to\phase1"
```

`/demo` has three inputs. **English text** and **Video link** go through Phase 1; **Gloss words** is the old direct input. The top right shows whether Phase 1 is
connected and whether it has its LLM key. Under the input, every sentence shows the English, the gloss that will be signed, and which layer produced it.

- **LLM layer first.** A sentence uses Layer 1's final gloss. If the LLM did not translate it (no key, quota, error) the spaCy layer's gloss is used and the row is
  marked *review*, because it is the weaker candidate. Phase 1's own review flag and warnings are shown on hover.
- **Phase 1 not running.** English text falls back to the old offline rule engine (`translateOffline`) and says so. A video link cannot, because the download and
  transcription are Phase 1's job.
- **Name differences.** Phase 1 writes `NOT` and `HI`; the signs are `NO` and `HELLO`. `SIGN_ALIASES` in `lib/sign/phase1.ts` renames them and the row says so.
  Add to it only after deciding that the two words are the same sign.
- **Keys.** The Groq key lives in Phase 1's own `.env`. This app never reads it, and the route only reports whether it is present.
- **Video.** Paste a public link, press *Read the video*, wait for the three steps (video, audio, transcript), then *Translate & sign*. The first 20 sentences are
  signed. Phase 1 limits: public videos, 30 minutes, one at a time.

App routes (all proxy to Phase 1 and accept loopback only): `POST /api/phase1/translate` (`{ text }` or `{ job_id }`), `GET /api/phase1/status`,
`POST /api/phase1/youtube` (`{ url }`) and `GET /api/phase1/youtube?job_id=`. The mapping from Phase 1's answer to the gloss is `extractSentences` in
`lib/sign/phase1.ts`, covered by `tests/phase1.test.ts`.
