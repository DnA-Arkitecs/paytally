# How the demo video is made

The submission video is a screen recording of the hosted demo with an AI voiceover, cut so each screen event lands on the words that describe it.

1. `node record.mjs` (Playwright, Chrome) records each beat of `docs/video-script.md` on the hosted demo as frames in `frames/`, marking every click and every wait on PayPal or the host.
2. `voice.py` (Kokoro TTS) writes one voice part per beat to `voice/`; `listen.py` and `words.py` (faster-whisper) check what a listener hears and save word timings.
3. `assemble.py` pins clicks to words, cuts waits short, burns in the captions, and renders `out/paytally-demo.mp4`; `check.py` and `listen_final.py` check the frames and the audio.

Folders `frames/`, `voice/`, `out/` and `fonts/` are made locally and not committed. Everything on screen is the demo's invented data and the PayPal sandbox.
