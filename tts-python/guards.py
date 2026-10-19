"""Babble and stumble guards for Chatterbox output. They regenerate or trim audio; they never touch text."""
import math

import torch

FRAME_SEC = 0.02
MAX_INNER_GAP = 0.8
TRIES = 3


def babble_limit(text):
    """Longest acceptable clip (s) for this text."""
    return 0.6 * len(text.split()) + 2.5


def _quiet_frames(wav, sr, rel_db):
    x = wav.flatten().float()
    n = int(FRAME_SEC * sr)
    frames = x[: len(x) // n * n].reshape(-1, n)
    rms = frames.pow(2).mean(dim=1).sqrt() + 1e-9
    return frames, (20 * torch.log10(rms / rms.max())) <= rel_db


def inner_gaps(wav, sr, rel_db=-35.0):
    """Lengths (s) of silent runs inside the clip, ignoring leading and trailing silence."""
    _, quiet = _quiet_frames(wav, sr, rel_db)
    loud = (~quiet).nonzero().flatten()
    if len(loud) == 0:
        return []
    gaps, run = [], 0
    for q in quiet[loud[0] : loud[-1] + 1].tolist():
        if q:
            run += 1
        elif run:
            gaps.append(run * FRAME_SEC)
            run = 0
    return gaps


def compress_gaps(wav, sr, over=0.7, to=0.35, rel_db=-35.0):
    """Shorten every silent run longer than `over` seconds to `to` seconds."""
    frames, quiet = _quiet_frames(wav, sr, rel_db)
    keep, start = [], None
    limit, keep_n = int(over / FRAME_SEC), int(to / FRAME_SEC)
    for i, q in enumerate(quiet.tolist() + [False]):
        if q and start is None:
            start = i
        elif not q and start is not None:
            run = list(range(start, i))
            keep += run if len(run) <= limit else run[:keep_n]
            start = None
        if not q and i < len(quiet):
            keep.append(i)
    return frames[keep].reshape(1, -1)


def _babble_guarded(gen, text, sr):
    limit = babble_limit(text)
    for i in range(TRIES):
        w = gen()
        if w.shape[-1] / sr <= limit:
            return w, i + 1
    return w[..., : int(limit * sr)], TRIES


def guarded_take(gen, text, sr):
    """Babble guard inside the stumble guard. Returns (clip, total generations)."""
    best, best_gap, used = None, None, 0
    for _ in range(TRIES):
        w, n = _babble_guarded(gen, text, sr)
        used += n
        g = max(inner_gaps(w, sr), default=0.0)
        if g <= MAX_INNER_GAP:
            return w, used
        if best is None or g < best_gap:
            best, best_gap = w, g
    return compress_gaps(best, sr), used


if __name__ == "__main__":
    tone = lambda s: 0.5 * torch.sin(torch.linspace(0, 440 * 2 * math.pi * s, int(24000 * s))).unsqueeze(0)
    gap = lambda s: torch.zeros(1, int(24000 * s))
    clip = torch.cat([gap(0.3), tone(1), gap(1.5), tone(1), gap(0.3)], -1)
    assert abs(max(inner_gaps(clip, 24000)) - 1.5) < 0.05  # leading/trailing silence ignored
    assert max(inner_gaps(compress_gaps(clip, 24000), 24000)) <= 0.36
    assert babble_limit("one two three four") == 0.6 * 4 + 2.5
    calls = iter([torch.cat([tone(1), gap(1.2), tone(1)], -1), torch.cat([tone(1), gap(0.2), tone(1)], -1)])
    w, n = guarded_take(lambda: next(calls), "a b c d e f", 24000)
    assert n == 2 and max(inner_gaps(w, 24000)) < 0.3
    long_clip = tone(20)  # babbles every try; the cut clip has no gap, so the stumble check passes
    w, n = guarded_take(lambda: long_clip, "a b", 24000)
    assert n == 3 and w.shape[-1] / 24000 <= babble_limit("a b") + 0.02
    worst = torch.cat([tone(1), gap(1.5), tone(18)], -1)  # babbles and stumbles every time
    w, n = guarded_take(lambda: worst, "a b", 24000)
    assert n == 9 and max(inner_gaps(w, 24000)) <= 0.36
    print("guards ok")
