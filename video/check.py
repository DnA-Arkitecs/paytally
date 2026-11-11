"""Checks the rendered video: duration, one frame per caption (and between), tiled into sheets, and what a listener hears."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "out"
mp4 = OUT / "paytally-demo.mp4"
probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,r_frame_rate",
                        "-of", "json", str(mp4)], capture_output=True, text=True, check=True)
print(probe.stdout)
caps = json.loads((OUT / "captions.json").read_text())
times = sorted({round((a + b) / 2, 2) for _, a, b in caps} | {1.0, 8.0, 15.0, 24.0, 52.0, 60.0, 70.0, 80.0, 95.0, 105.0, 113.0, 121.0})
shots = OUT / "check"
shots.mkdir(exist_ok=True)
for f in shots.glob("*.jpg"):
    f.unlink()
for i, t in enumerate(times):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(mp4), "-frames:v", "1",
                    "-vf", f"scale=640:-1,drawtext=fontfile=fonts/segoeui.ttf:text='{t:.1f}s':fontsize=28:fontcolor=red:x=8:y=8",
                    str(shots / f"{i:02d}.jpg")], check=True, cwd=ROOT)
n = len(times)
for k in range(0, n, 12):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-start_number", str(k), "-i", str(shots / "%02d.jpg"), "-frames:v", "1",
                    "-vf", "tile=3x4", str(OUT / f"check_sheet_{k // 12}.jpg")], check=True)
    print(OUT / f"check_sheet_{k // 12}.jpg", times[k:k + 12])
