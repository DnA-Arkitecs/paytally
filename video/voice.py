"""PayTally video voiceover: Kokoro af_heart at 1.03 (video-studio's voice), one WAV per part.
Spoken text uses respellings where a word on screen would be misread (CRM, MCP, AG Grid, D, NS)."""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline

OUT = Path(__file__).parent / "voice"
OUT.mkdir(exist_ok=True)
SR = 24000

PARTS = {
    "b1a": "If you're paid per result, per booked call or per qualified lead, month-end means matching a calendar, a C R M and client emails against each client's terms, by hand. "
           "My outbound system has booked two thousand, four hundred twenty-four meetings for financial advisors, and billing them was the messiest step. So I built Pay Tally.",
    "b1b": "On one real week of my own bookings, it matched fifteen of fifteen billable meetings.",
    "b2": "This is a made-up agency with three clients on different terms. Claude reads every row and cites its sources. "
          "Plain code applies each client's terms, so every line says why it's billed and where it came from. "
          "Here Claude caught a call marked Completed, with the note: en ess. A no-show. It didn't guess. It flagged it. "
          "I press dee, don't bill, approve, and PayPal's Agent Toolkit creates and sends the invoices.",
    "b3": "Now the other side. Mesa Ridge has its own AI agent. It connects to Pay Tally over M C P, with a token that sees only its own bill, "
          "and its human set a two-thousand-dollar cap that's enforced in code. It checks ten lines against its own field log, asks for proof on one, and disputes it. "
          "Pay Tally's agent reviews the dispute, cites the rows, and recommends a credit. The credit is my click. "
          "PayPal cancels the invoice and sends a corrected one: twenty-one hundred becomes eighteen fifty. "
          "The client's agent checks the new invoice and asks to pay. It can't move money itself. "
          "Its human approves the exact amount, PayPal charges the card saved in its vault, and PayPal's webhook marks the invoice paid.",
    "b4": "At month-end, the owner sees the whole month in one dashboard, built on the same grid, and can ask it questions. Claude answers from the same numbers.",
    "b5": "AI agents did the reading, the checking and the arguing. Code did the math. People approved every dollar, and PayPal moved it. "
          "I built it by directing AI coding agents. That's Pay Tally.",
}

only = sys.argv[1:] or list(PARTS)
pipe = KPipeline(lang_code="a")
durs = {}
for name in only:
    chunks = []
    for _, _, audio in pipe(PARTS[name], voice="af_heart", speed=1.03, split_pattern=r"\n+"):
        a = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
        chunks.append(a)
        chunks.append(np.zeros(int(SR * 0.12), dtype=a.dtype))
    wav = np.concatenate(chunks)
    sf.write(OUT / f"{name}.wav", wav, SR)
    durs[name] = round(len(wav) / SR, 2)
    print(name, durs[name], "s")
old = json.loads((OUT / "durations.json").read_text()) if (OUT / "durations.json").exists() else {}
old.update(durs)
(OUT / "durations.json").write_text(json.dumps(old, indent=1))
print("total", round(sum(old.values()), 1), "s")
