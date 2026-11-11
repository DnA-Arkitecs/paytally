"""Word start times for each voice part (faster-whisper, CPU), saved to voice/words.json.
The editor uses them to line screen events and captions up with what the voice says."""
import json
import subprocess
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

VOICE = Path(__file__).parent / "voice"
model = WhisperModel("small.en", device="cpu", compute_type="int8")
out = {}
for wav in sorted(VOICE.glob("*.wav")):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(wav), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                         capture_output=True, check=True).stdout
    segs, _ = model.transcribe(np.frombuffer(raw, np.float32), beam_size=5, word_timestamps=True)
    out[wav.stem] = [{"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)} for s in segs for w in s.words]
    print(wav.stem, " ".join(f"{x['w']}@{x['s']}" for x in out[wav.stem]))
(VOICE / "words.json").write_text(json.dumps(out, indent=1))
