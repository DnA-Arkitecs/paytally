"""Transcribes the rendered video's audio with timestamps, so a chat can check what a viewer hears and when."""
import subprocess
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

mp4 = Path(__file__).parent / "out" / "paytally-demo.mp4"
raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(mp4), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                     capture_output=True, check=True).stdout
model = WhisperModel("small.en", device="cpu", compute_type="int8")
segs, _ = model.transcribe(np.frombuffer(raw, np.float32), beam_size=5)
for s in segs:
    print(f"{s.start:6.1f}-{s.end:6.1f} {s.text.strip()}")
