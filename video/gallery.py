"""Three 3:2 gallery images for Devpost from the recorded frames: the ledger with a flagged line open,
the client's agent after PayPal settles, and the AG Studio dashboard with its assistant's answer."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
FR = ROOT / "frames"
OUT = ROOT / "out"
TL = json.loads((FR / "timeline.json").read_text())["segments"]


def frame_at(seg, t):
    best = TL[seg]["frames"][0]
    for f in TL[seg]["frames"]:
        if f["t"] <= t:
            best = f
    return FR / seg / best["f"]


def mark(seg, key):
    return next(m["t"] for m in TL[seg]["marks"] if key in m["label"])


picks = {  # name: (frame, crop x offset); the studio keeps its left edge, where the assistant's answer sits
    "gallery-1-ledger.jpg": (frame_at("b2", mark("b2", "flag-priya") + 2.5), 125),
    "gallery-2-agent-settled.jpg": (FR / "b3" / TL["b3"]["frames"][-1]["f"], 125),
    "gallery-3-studio.jpg": (FR / "b4" / TL["b4"]["frames"][-1]["f"], 0),
}
dest = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
for name, (src, x) in picks.items():
    out = OUT / name
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", f"crop=1350:900:{x}:0,scale=1500:1000:flags=lanczos",
                    "-q:v", "2", str(out)], check=True)
    if dest != OUT:
        shutil.copy(out, dest / name)
    print(name, "<-", src.name)
