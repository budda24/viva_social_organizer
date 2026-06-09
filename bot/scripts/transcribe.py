#!/usr/bin/env python3
"""Transcribe an audio file to text with faster-whisper. Prints ONLY the
transcript to stdout (logs go to stderr) so the Node caller can read it cleanly.

Usage: python transcribe.py <audio-file>
Env:
  STT_MODEL    model size (default "small") — tiny/base/small/medium/large-v3
  STT_DEVICE   "cpu" (default) or "cuda" (needs nvidia-cublas/cudnn libs)
  STT_COMPUTE  "int8" (cpu default) or "float16" (cuda)
  STT_LANGUAGE optional ISO code to force (default: auto-detect; handles EN+FR)

The model is cached after first download (~/.cache/huggingface), so only the
first ever call pays the download cost.
"""
import os
import sys

def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: transcribe.py <audio-file>\n")
        return 2
    audio = sys.argv[1]
    if not os.path.exists(audio):
        sys.stderr.write(f"file not found: {audio}\n")
        return 2

    from faster_whisper import WhisperModel

    model_size = os.environ.get("STT_MODEL", "small")
    device = os.environ.get("STT_DEVICE", "cpu")
    compute = os.environ.get("STT_COMPUTE", "int8" if device == "cpu" else "float16")
    language = os.environ.get("STT_LANGUAGE") or None

    model = WhisperModel(model_size, device=device, compute_type=compute)
    segments, _info = model.transcribe(audio, language=language)
    text = "".join(seg.text for seg in segments).strip()
    sys.stdout.write(text)
    return 0

if __name__ == "__main__":
    sys.exit(main())
