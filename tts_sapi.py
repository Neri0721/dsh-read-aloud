# -*- coding: utf-8 -*-
"""离线备用语音合成：Windows 自带 SAPI（Microsoft Huihui 中文声线）

用途：edge-tts 被微软限流（403）时兜底，保证朗读功能不中断。
用法：
    python tts_sapi.py voices                     → 列出可用的 SAPI 声线
    echo {"text":"...","rate":8,"voice":"Huihui"} | python tts_sapi.py speak  → stdout 输出 MP3
说明：必须跑在装了 ffmpeg 的机器上；语法用 PowerShell 调 System.Speech，无需第三方库。
"""

import json
import os
import subprocess
import shutil
import tempfile
import sys

def _first_existing(*cands):
    for c in cands:
        if c and os.path.exists(c):
            return c
    return cands[0] or ""


AI = os.environ.get("DSH_READ_ALOUD_AI_DIR") or os.path.join(os.path.expanduser("~"), "AI")
FFMPEG = _first_existing(
    os.environ.get("DSH_READ_ALOUD_FFMPEG"),
    shutil.which("ffmpeg"),
    os.path.join(AI, "bin", "ffmpeg.exe"),
    "/usr/bin/ffmpeg",
)
TMP = os.path.join(tempfile.gettempdir(), "dsh-read-aloud")
DEFAULT_VOICE = "Microsoft Huihui Desktop"


def _ps(code: str) -> str:
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return (proc.stdout or "") + (proc.stderr or "")


def list_voices():
    code = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.GetInstalledVoices()|ForEach-Object{"
        "$i=$_.VoiceInfo;Write-Output ($i.Name+'|'+$i.Culture.Name+'|'+$i.Gender)}"
    )
    out = []
    for line in _ps(code).splitlines():
        parts = line.strip().split("|")
        if len(parts) == 3 and parts[0]:
            out.append({"name": parts[0], "culture": parts[1], "gender": parts[2]})
    return out


def speak(params):
    text = (params.get("text") or "").strip()
    if not text:
        raise RuntimeError("文本为空")
    voice = params.get("sapiVoice") or DEFAULT_VOICE
    rate = int(params.get("sapiRate", 0) or 0)
    rate = max(-10, min(10, rate))
    os.makedirs(TMP, exist_ok=True)
    wav = os.path.join(TMP, "_sapi_out.wav")
    mp3 = os.path.join(TMP, "_sapi_out.mp3")
    for p in (wav, mp3):
        if os.path.exists(p):
            os.remove(p)

    safe = text.replace("'", "''").replace("\r", " ").replace("\n", " ")
    voice_safe = voice.replace("'", "''")
    code = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "try{$s.SelectVoice('%s')}catch{};"
        "$s.Rate=%d;"
        "$s.SetOutputToWaveFile('%s');"
        "$s.Speak('%s');"
        "$s.Dispose()" % (voice_safe, rate, wav.replace("'", "''"), safe)
    )
    log = _ps(code)
    if not os.path.exists(wav) or os.path.getsize(wav) < 2000:
        raise RuntimeError("SAPI 合成失败: " + log[-300:])

    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", wav, "-b:a", "96k", mp3], check=True)
    with open(mp3, "rb") as f:
        return f.read()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "speak"
    if mode == "voices":
        sys.stdout.buffer.write(json.dumps(list_voices(), ensure_ascii=False).encode("utf-8"))
        return
    params = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
    sys.stdout.buffer.write(speak(params))


if __name__ == "__main__":
    main()
