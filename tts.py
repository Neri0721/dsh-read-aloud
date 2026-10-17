# -*- coding: utf-8 -*-
"""dsh-read-aloud TTS 助手：从 stdin 读 JSON 参数，把合成好的 MP3 写到 stdout。
参数: {"text":..., "voice":..., "rate":"+0%", "pitch":"+0Hz", "volume":"+0%"}
用法: python tts.py voices            # 输出音色清单 JSON
      echo {json} | python tts.py speak
"""
import asyncio, json, os, subprocess, sys

async def list_voices():
    import edge_tts
    vs = await edge_tts.list_voices()
    out = []
    for v in vs:
        loc = v.get("Locale", "")
        out.append({
            "id": v["ShortName"],
            "locale": loc,
            "gender": v.get("Gender", ""),
            "name": v.get("FriendlyName", "").split(" - ")[0].replace("Microsoft ", "").strip(),
            "zh": loc.startswith("zh"),
        })
    out.sort(key=lambda x: (0 if x["zh"] else 1, x["locale"], x["id"]))
    return out

async def speak(p):
    import edge_tts
    text = (p.get("text") or "").strip()
    if not text:
        raise SystemExit("empty text")
    kwargs = {
        "voice": p.get("voice") or "zh-CN-XiaoyiNeural",
        "rate": p.get("rate") or "+0%",
        "pitch": p.get("pitch") or "+0Hz",
        "volume": p.get("volume") or "+0%",
    }
    communicate = edge_tts.Communicate(text, **kwargs)
    buf = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    return bytes(buf)

def sapi_speak(params):
    """离线兜底：调用同目录的 tts_sapi.py（Windows 自带语音）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    payload = json.dumps({"text": params.get("text", ""), "sapiRate": 2}, ensure_ascii=False)
    proc = subprocess.run(
        [sys.executable, os.path.join(here, "tts_sapi.py"), "speak"],
        input=payload.encode("utf-8"),
        capture_output=True,
    )
    if proc.returncode == 0 and len(proc.stdout) > 512:
        print("[tts] edge-tts 不可用，已改用离线语音兜底 ✓", file=sys.stderr)
        return proc.stdout
    raise RuntimeError("edge-tts 与离线兜底均失败: " + proc.stderr.decode("utf-8", "replace")[:200])


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "speak"
    if mode == "voices":
        data = asyncio.run(list_voices())
        sys.stdout.buffer.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        return
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    params = json.loads(raw or "{}")
    try:
        audio = asyncio.run(speak(params))
        if not audio:
            raise RuntimeError("edge-tts 返回空音频")
    except Exception as exc:
        print("[tts] edge-tts 失败（%s），改用离线兜底" % type(exc).__name__, file=sys.stderr)
        audio = sapi_speak(params)
    sys.stdout.buffer.write(audio)

if __name__ == "__main__":
    main()