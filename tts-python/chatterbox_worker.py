"""Chatterbox worker: one model per process, JSON lines on stdin/stdout, logs on stderr.

in : {"id", "text", "opts": {"voice": "turbo:<name>"|"cb:<name>", "speed", "padSec"}, "mp3Path"}
out: {"ready": true} once, then {"id", "durationSec", "retries"} or {"id", "error"}
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TQDM_DISABLE", "1")  # no per-token "Sampling" bars in the server log
# stdout carries only protocol replies; library prints go to stderr
PROTO = sys.stdout
sys.stdout = sys.stderr

import torch  # noqa: E402
import torchaudio as ta  # noqa: E402

from guards import guarded_take  # noqa: E402

SETTINGS = {
    "turbo": {"temperature": 0.65, "top_p": 0.9},
    "chatterbox": {"exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8},
}


def log(engine, msg):
    # The Node pool adds the timestamp and [tts-<engine>] scope
    print(msg, file=sys.stderr, flush=True)


def reply(obj):
    PROTO.write(json.dumps(obj) + "\n")
    PROTO.flush()


def load(engine):
    # CPU, not MPS: MPS caches buffers per decode length (~25 GB after one chunk); CPU stays ~5 GB and Turbo runs faster
    device = "cpu"
    if engine == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        return ChatterboxTurboTTS.from_pretrained(device=device)
    from chatterbox.tts import ChatterboxTTS
    return ChatterboxTTS.from_pretrained(device=device)


def synthesize(model, args, req):
    opts = req["opts"]
    name = opts["voice"].split(":", 1)[1]
    clip = os.path.join(args.voices_dir, f"{name}.wav")
    if not os.path.exists(clip):
        raise FileNotFoundError(f"Voice clip {name}.wav is missing")
    text, sr, speed = req["text"], model.sr, float(opts.get("speed") or 1.0)
    t0 = time.time()
    wav, gens = guarded_take(lambda: model.generate(text, audio_prompt_path=clip, **SETTINGS[args.engine]).cpu(), text, sr)
    pad = float(opts.get("padSec") or 0)
    if pad > 0:
        wav = torch.cat([wav, torch.zeros(1, int(pad * sr))], dim=-1)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        ta.save(tmp_path, wav, sr)
        os.makedirs(os.path.dirname(req["mp3Path"]), exist_ok=True)
        subprocess.run(
            [args.ffmpeg, "-y", "-loglevel", "error", "-i", tmp_path, "-filter:a", f"atempo={speed}",
             "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "64k", req["mp3Path"]],
            # posix_spawn, not fork: fork in a threaded torch process can SIGTRAP in malloc
            check=True, close_fds=False, stdin=subprocess.DEVNULL,
        )
    finally:
        os.unlink(tmp_path)
    duration = wav.shape[-1] / sr / speed
    log(args.engine, f"chunk chars={len(text)} gens={gens} ms={int((time.time() - t0) * 1000)} audio={duration:.1f}s")
    return {"durationSec": duration, "retries": gens - 1}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", choices=list(SETTINGS), required=True)
    p.add_argument("--voices-dir", required=True)
    p.add_argument("--ffmpeg", required=True)
    args = p.parse_args()
    t0 = time.time()
    model = load(args.engine)
    log(args.engine, f"model loaded in {time.time() - t0:.1f}s")
    reply({"ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            reply({"id": req["id"], **synthesize(model, args, req)})
        except Exception as e:  # one bad request must not kill the worker
            log(args.engine, f"request {req.get('id')} failed: {e}")
            reply({"id": req.get("id"), "error": str(e)})


if __name__ == "__main__":
    main()
