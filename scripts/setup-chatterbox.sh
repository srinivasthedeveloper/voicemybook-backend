#!/usr/bin/env bash
# Creates the Python env for the Chatterbox engines (Turbo + original)
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo "uv not found: install from https://docs.astral.sh/uv/" >&2; exit 1; }
uv venv --python 3.11 tts-python/.venv
uv pip install --python tts-python/.venv/bin/python -r tts-python/requirements.txt
