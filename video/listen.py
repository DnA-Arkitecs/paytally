"""Transcribe each voice part with faster-whisper (CPU) so a chat can read what a listener hears."""
import subprocess
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel("small.en", device="cpu", compute_type="int8")
for wav in sorted((Path(__file__).parent / "voice").glob("*.wav")):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(wav), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                         capture_output=True, check=True).stdout
    segs, _ = model.transcribe(np.frombuffer(raw, np.float32), beam_size=5)
    print(f"[{wav.stem}]", " ".join(s.text.strip() for s in segs))
