#!/usr/bin/env python3
"""Play the macOS system Ping sound."""

import subprocess
import sys

SOUND = "/System/Library/Sounds/Ping.aiff"

def beep() -> None:
    subprocess.run(["afplay", SOUND], check=True)

if __name__ == "__main__":
    beep()
