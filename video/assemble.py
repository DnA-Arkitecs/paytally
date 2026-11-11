"""Cuts the recorded frames to the AI voice and renders out/paytally-demo.mp4 (1920x1080, 30 fps).

Each shot pins screen events (clicks, waits ending) to the words the voice says at that moment.
Between two pins the recording is played as is, with waits on the host or PayPal cut short;
when the screen needs more time than the voice gives, a short silence goes into the voice there.
Run with the video-studio venv: tts-venv python assemble.py
"""
import json
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).parent
FR = ROOT / "frames"
VO = ROOT / "voice"
OUT = ROOT / "out"
CAPS = OUT / "caps"
CAPS.mkdir(parents=True, exist_ok=True)
TL = json.loads((FR / "timeline.json").read_text())["segments"]
WORDS = json.loads((VO / "words.json").read_text())
SR = 24000
LEAD, TAIL = 0.35, 0.45
MAXSPEED, MINSPEED = 1.35, 0.7
KEEP = {"wait": 0.45, "stream": 1.8}
FONT = "fonts/seguisb.ttf"


def norm(s):
    return re.sub(r"[^a-z0-9']", "", s.lower().replace("’", "'"))


def W(part, phrase, after=0.0, shift=0.0):
    """Start time (s) of a phrase in a voice part, from the Whisper word timings."""
    toks = [norm(x) for x in phrase.split()]
    ws = WORDS[part]
    for i in range(len(ws) - len(toks) + 1):
        if ws[i]["s"] + 1e-6 < after:
            continue
        if all(norm(ws[i + j]["w"]) == toks[j] for j in range(len(toks))):
            return max(0.0, ws[i]["s"] + shift)
    raise SystemExit(f"word not found: {part} {phrase!r}")


def mark(seg, key, n=0):
    hits = [m["t"] for m in TL[seg]["marks"] if key in m["label"]]
    if len(hits) <= n:
        raise SystemExit(f"mark not found: {seg} {key!r} #{n}; have {[m['label'] for m in TL[seg]['marks']]}")
    return hits[n]


def wait_end(seg, after):
    for w in TL[seg]["waits"]:
        if w["a"] >= after - 0.05:
            return w["b"]
    raise SystemExit(f"no wait after {after} in {seg}")


def S(seg, which):
    return TL[seg][which]


def voice_len(part):
    return sf.info(str(VO / f"{part}.wav")).duration


# ---------- The shots: (segment, source time, voice time) pins, and captions in voice time ----------
def shots():
    b2_build = mark("b2", "click:Read the work log")
    b3_check = mark("b3", "checks the invoice")
    b3_send = mark("b3", "& send reply")
    b3_picks = mark("b3", "picks it back up")
    b3_pay = mark("b3", "click:Approve $")
    b4_ask = mark("b4", "ask-sent")
    return [
        dict(part="b1a", keys=[
            ("b1h", S("b1h", "start"), None),
            ("b1h", S("b1h", "stop"), W("b1a", "month", shift=-0.25)),
            ("b1w", S("b1w", "start"), W("b1a", "month", shift=-0.25)),
            ("b1w", S("b1w", "stop"), "END"),
        ], caps=[("Paid per result? Month-end is reconciliation.", 0, "END")]),
        dict(part="b1b", card=True, caps=[]),
        dict(part="b2", keys=[
            ("b2", S("b2", "start"), None),
            ("b2", b2_build, W("b2", "claude", shift=-0.35)),
            ("b2", wait_end("b2", b2_build), W("b2", "plain", shift=-0.15)),
            ("b2", mark("b2", "Dana Whitfield"), W("b2", "so every", shift=-0.2)),
            ("b2", mark("b2", "flag-priya"), W("b2", "here", shift=-0.2)),
            ("b2", mark("b2", "key:d"), W("b2", "d", after=17, shift=-0.1)),
            ("b2", mark("b2", "click:Approve & send"), W("b2", "and paypal's", shift=-0.15), 2.3),
            ("b2", S("b2", "stop"), "END", 1.9),
        ], caps=[
            ("Claude Opus 5.5 reads every row", 0, W("b2", "plain", shift=-0.15)),
            ("Code prices each line", W("b2", "plain", shift=-0.15), W("b2", "and paypal's", shift=-0.15)),
            ("PayPal Agent Toolkit: create_invoice, send_invoice", W("b2", "and paypal's", shift=-0.15), "END"),
        ]),
        dict(part="b3", keys=[
            ("b3", S("b3", "start"), None),
            ("b3", b3_check, W("b3", "it checks", shift=-0.25)),
            ("b3", wait_end("b3", b3_check), W("b3", "paytally's", shift=-0.25)),
            ("b3", mark("b3", "Claude's call"), W("b3", "the credit", shift=-0.15)),
            ("b3", b3_send, W("b3", "paypal cancels", shift=-0.3)),
            ("b3", wait_end("b3", b3_send), W("b3", "2100", shift=-0.15)),
            ("b3", b3_picks, W("b3", "the client's", shift=-0.2)),
            ("b3", wait_end("b3", b3_picks), W("b3", "its human", after=30, shift=-0.25)),
            ("b3", b3_pay, W("b3", "paypal charges", shift=-0.25)),
            ("b3", wait_end("b3", b3_pay), W("b3", "paypal's webhook", shift=-0.15)),
            ("b3", S("b3", "stop"), "END"),
        ], caps=[
            ("MCP: its token sees one client's bill", W("b3", "it connects", shift=-0.1), W("b3", "human", shift=-0.2)),
            ("Cap enforced in code", W("b3", "human", shift=-0.2), W("b3", "paytally's", shift=-0.25)),
            ("PayPal: cancel_sent_invoice, create_invoice", W("b3", "paypal cancels", shift=-0.3), W("b3", "its human", after=30, shift=-0.25)),
            ("PayPal Vault + Orders v2: saved card charged", W("b3", "its human", after=30, shift=-0.25), W("b3", "paypal's webhook", shift=-0.15)),
            ("PayPal webhook: invoice paid", W("b3", "paypal's webhook", shift=-0.15), "END"),
        ]),
        dict(part="b4", keys=[
            ("b4", S("b4", "start"), None),
            ("b4", mark("b4", "Edit layout"), W("b4", "built", shift=-0.2)),
            ("b4", b4_ask, W("b4", "questions", shift=0.3)),
            ("b4", wait_end("b4", b4_ask), W("b4", "claude", shift=-0.15)),
            ("b4", S("b4", "stop"), "END"),
        ], caps=[("AG Grid + AG Studio, assistant on Claude", 0, "END")]),
        dict(part="b5", keys=[
            ("b5a", S("b5a", "start"), None),
            ("b5a", S("b5a", "stop"), W("b5", "people", shift=-0.2)),
            ("b5b", S("b5b", "start"), W("b5", "people", shift=-0.2)),
            ("b5b", S("b5b", "stop"), "END"),
        ], caps=[("Claude reads. Code counts. People approve. PayPal pays.", 0, "END")]),
    ]


# ---------- Timing one piece of recording into the time the voice gives it ----------
def plan_piece(seg, s0, s1, avail, maxspeed=MAXSPEED):
    """Returns (sub-pieces [(sa, sb, out_len)], hold, out_len)."""
    if s1 <= s0:
        return [], max(avail, 0.0), max(avail, 0.0)
    cuts = [(max(w["a"], s0), min(w["b"], s1), w["kind"]) for w in TL[seg]["waits"] if w["b"] > s0 and w["a"] < s1]
    subs, t = [], s0
    for a, b, kind in cuts:
        if a > t:
            subs.append([t, a, None])
        subs.append([a, b, kind])
        t = b
    if t < s1:
        subs.append([t, s1, None])
    plain = sum(b - a for a, b, k in subs if k is None)
    waits = [(b - a, min(KEEP[k], b - a)) for a, b, k in subs if k]
    full = plain + sum(w for w, _ in waits)
    kept = plain + sum(k for _, k in waits)
    out = []
    if avail > 0 and full <= avail:
        f = max(MINSPEED, full / avail)
        for a, b, k in subs:
            out.append((a, b, (b - a) / f))
        used = full / f
        return out, avail - used, avail
    if avail > 0 and kept <= avail:
        extra = sum(w - k for w, k in waits)
        lam = (avail - kept) / extra if extra else 0
        for a, b, k in subs:
            ln = b - a
            out.append((a, b, ln if k is None else min(KEEP[k], ln) + (ln - min(KEEP[k], ln)) * lam))
        return out, 0.0, avail
    speed = kept / avail if avail > 0 else maxspeed + 1
    speed = speed if avail > 0 and speed <= maxspeed else maxspeed
    for a, b, k in subs:
        ln = b - a
        out.append((a, b, (ln if k is None else min(KEEP[k], ln)) / speed))
    used = sum(o for _, _, o in out)
    return out, 0.0, max(used, avail)


def frames_for(seg, subs, hold):
    fr = TL[seg]["frames"]
    ts = [f["t"] for f in fr]
    entries = []
    last = None
    for sa, sb, ol in subs:
        if sb <= sa:
            continue
        rate = ol / (sb - sa)
        i = max(0, np.searchsorted(ts, sa, side="right") - 1)
        while i < len(fr) and ts[i] < sb:
            a = max(ts[i], sa)
            b = min(ts[i + 1] if i + 1 < len(fr) else sb, sb)
            if b > a:
                entries.append([FR / seg / fr[i]["f"], (b - a) * rate])
            last = FR / seg / fr[i]["f"]
            i += 1
    if hold > 0:
        if last is None:
            i = max(0, np.searchsorted(ts, subs[-1][1] if subs else TL[seg]["stop"], side="right") - 1)
            last = FR / seg / fr[i]["f"]
        entries.append([last, hold])
    return entries


def build_shot(sh):
    part = sh["part"]
    vlen = voice_len(part)
    gaps = []  # (voice time, seconds of silence inserted there)

    def v2o(v):
        return LEAD + v + sum(d for t, d in gaps if t <= v + 1e-6)

    entries = []
    if sh.get("card"):
        total = LEAD + vlen + TAIL + 0.3
        entries.append([OUT / "card.jpg", total])
    else:
        keys = sh["keys"]
        out_prev = 0.0
        vts = [k[2] for k in keys if isinstance(k[2], (int, float))]
        assert vts == sorted(vts), f"{part}: voice pins out of order {vts}"
        for k0, k1 in zip(keys, keys[1:]):
            (sg0, s0, v0), (sg1, s1, v1) = k0[:3], k1[:3]
            maxspeed = k1[3] if len(k1) > 3 else MAXSPEED
            end = v1 == "END"
            target = v2o(vlen) + TAIL if end else v2o(v1)
            avail = target - out_prev
            if sg0 != sg1:  # a cut between two recordings
                if avail > 1e-3:
                    entries.append([FR / sg0 / TL[sg0]["frames"][-1]["f"], avail])
                out_prev = target
                continue
            subs, hold, used = plan_piece(sg0, s0, s1, avail, maxspeed)
            if used > avail + 1e-3:
                gaps.append((vlen if end else v1, used - avail))
            entries += frames_for(sg0, subs, hold)
            out_prev += used
        total = out_prev
    # The voice, with its inserted silences.
    wav, _ = sf.read(str(VO / f"{part}.wav"), dtype="float32")
    pieces, cur = [np.zeros(int(LEAD * SR), np.float32)], 0
    for t, d in sorted(gaps):
        k = int(min(t, vlen) * SR)
        pieces += [wav[cur:k], np.zeros(int(d * SR), np.float32)]
        cur = k
    pieces.append(wav[cur:])
    audio = np.concatenate(pieces)
    n = int(round(total * SR))
    audio = np.pad(audio, (0, max(0, n - len(audio))))[:n]
    caps = []
    for text, a, b in sh["caps"]:
        oa = 0.25 if a == 0 else v2o(a)
        ob = total - 0.2 if b == "END" else v2o(b) - 0.05
        caps.append((text, oa, ob))
    return entries, audio, caps, total, gaps


def make_card():
    lines = ["On one real week of my own bookings (Oct 12–18, 2026),",
             "PayTally read all 96 and matched 15 of 15 billable",
             "meetings to my records at the right price,",
             "and flagged 1 for my review."]
    vf = ["drawbox=x=(iw-1500)/2:y=330:w=110:h=8:color=0x1F6F5C:t=fill"]
    for i, ln in enumerate(lines):
        p = CAPS / f"card{i}.txt"
        p.write_text(ln, encoding="utf-8")
        vf.append(f"drawtext=fontfile={FONT}:textfile={p.relative_to(ROOT).as_posix()}:expansion=none:fontsize=62:"
                  f"fontcolor=0x1A2033:x=(w-1500)/2:y={380 + i * 92}")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xF6F4EE:s=1920x1080", "-frames:v", "1",
                    "-vf", ",".join(vf) + ",scale=1600:900:flags=lanczos", "-q:v", "2", str(OUT / "card.jpg")], check=True, cwd=ROOT)
    # The recorded frames are 1600x900; every image in the frame list must be the same size or the card is dropped.


def main():
    make_card()
    allE, allA, allC, t0 = [], [], [], 0.0
    report = []
    for sh in shots():
        e, a, c, total, gaps = build_shot(sh)
        allE += e
        allA.append(a)
        allC += [(txt, t0 + x, t0 + y) for txt, x, y in c]
        report.append(f"{sh['part']}: {total:.1f}s, voice {voice_len(sh['part']):.1f}s, silences {[(round(t, 1), round(d, 1)) for t, d in gaps]}")
        t0 += total
    audio = np.concatenate(allA)
    sf.write(str(OUT / "voice_track.wav"), audio, SR)
    lst = ["ffconcat version 1.0"]
    for p, d in allE:
        lst += [f"file '{Path(p).as_posix()}'", f"duration {d:.5f}"]
    lst.append(f"file '{Path(allE[-1][0]).as_posix()}'")
    (OUT / "frames.ffconcat").write_text("\n".join(lst) + "\n")
    vf = ["fps=30", "scale=1920:1080:flags=lanczos", "setsar=1"]
    for i, (txt, a, b) in enumerate(allC):
        p = CAPS / f"c{i}.txt"
        p.write_text(txt, encoding="utf-8")
        vf.append(f"drawtext=fontfile={FONT}:textfile={p.relative_to(ROOT).as_posix()}:expansion=none:fontsize=46:"
                  f"fontcolor=white:box=1:boxcolor=0x111827@0.80:boxborderw=22:x=(w-text_w)/2:y=h-150:"
                  f"enable='between(t,{a:.3f},{b:.3f})'")
    vf += ["fade=t=in:st=0:d=0.4", f"fade=t=out:st={t0 - 0.6:.3f}:d=0.6", "format=yuv420p"]
    (OUT / "filters.txt").write_text(",".join(vf))
    mp4 = OUT / "paytally-demo.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(OUT / "frames.ffconcat"),
                    "-i", str(OUT / "voice_track.wav"), "-vf", ",".join(vf),
                    "-af", f"afade=t=in:d=0.3,afade=t=out:st={t0 - 0.6:.3f}:d=0.6,aresample=48000",
                    "-map", "0:v", "-map", "1:a", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
                    "-c:a", "aac", "-b:a", "192k", "-t", f"{t0:.3f}", "-movflags", "+faststart", str(mp4)],
                   check=True, cwd=ROOT)
    print("\n".join(report))
    print(f"total {t0:.1f}s ({int(t0 // 60)}:{t0 % 60:04.1f}) -> {mp4}")
    (OUT / "captions.json").write_text(json.dumps(allC, indent=1))


if __name__ == "__main__":
    main()
