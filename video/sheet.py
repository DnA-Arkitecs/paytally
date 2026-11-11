"""Contact sheet per segment: 8 evenly spaced frames, tiled, so a chat can look at the recording."""
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).parent / "frames"
log = json.loads((root / "timeline.json").read_text())
for name in (sys.argv[1:] or log["segments"]):
    frames = log["segments"][name]["frames"]
    pick = [frames[round(i * (len(frames) - 1) / 7)]["f"] for i in range(8)] if len(frames) >= 8 else [f["f"] for f in frames]
    lst = root / f"{name}_pick.txt"
    lst.write_text("".join(f"file '{(root / name / p).as_posix()}'\n" for p in pick))
    out = root / f"sheet_{name}.jpg"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-vf", "scale=640:-1,tile=4x2", "-frames:v", "1", str(out)], check=True)
    print(out)
