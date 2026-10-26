# ISL text-to-sign: transcript to gloss to avatar

One repository for the whole pipeline. English text, speech or a video link goes in; an avatar signs it in Indian Sign Language (ISL).

```
isl-text2sign-dict-corpus/
  phase1/   Python. Transcript cleaning, sentence chunking, context grouping, gloss (LLM layer through Groq + spaCy layer), YouTube ingest (yt-dlp + Whisper).
  phase2/   Next.js. Resolves each gloss word to a sign (hand-made animation, avatar motion from the ISLRTC dictionary, dictionary video, fingerspelling) and signs it with a 3D avatar.
```

They stay two programs that talk over HTTP on this machine (Phase 1 on `127.0.0.1:8765`, Phase 2 on `localhost:3000`). Each folder keeps its own README, tests and dependencies; the full history of both original repositories is in this repository's log.

## Run it

```powershell
# one-off setup
cd phase2;  npm ci
cd ..\phase1; python -m venv .venv; .venv\Scripts\pip install -e ".[layer2,youtube]"; .venv\Scripts\python -m spacy download en_core_web_sm
copy <old signLanguage folder>\.env .env       # holds GROQ_API_KEY; never committed

# every time: starts Phase 1, then the app (http://localhost:3000/demo)
powershell -NoProfile -ExecutionPolicy Bypass -File phase2\scripts\dev-all.ps1
```

`phase2/docs/islrtc_setup.md` has the environment variables, the endpoints and how the two phases are joined. The folder name of the old Phase 2 project contained a `&`, which breaks `npm run`; this layout does not.

## Data

| Where | What | In git? |
|---|---|---|
| `phase1/data/` | transcripts, cleaned text, gloss files, review sheets | tracked, except `jobs/`, `demo/` and the LLM cache |
| `phase2/data/islrtc/` | dictionary manifest, lexicon, approved mappings, the NIOS textbook PDF | **ignored** |
| `phase2/data/pose/` | avatar tracks and landmarks extracted from the dictionary clips (about 2.3 GB) | **ignored** |
| `phase2/data/coverage/` | per-word coverage list | **ignored** |
| Google Drive `islrtc` folder | the 13,665 dictionary clips | not copied; set `ISLRTC_DATA_DIR` |

The ignored files are derived from the ISLRTC dictionary, and the original project marked them "not for redistribution", so they are copied locally but kept out of git. Change `phase2/.gitignore` only if you have the right to publish them.

## Secrets

`.env` files are ignored everywhere. Phase 1 reads `GROQ_API_KEY` from `phase1/.env`; Phase 2 never reads it.
