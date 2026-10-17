# -*- coding: utf-8 -*-
"""dsh-read-aloud 的 RVC 变声助手

用法：
    python tts_rvc.py models
        → 输出可用 RVC 声线清单 JSON（[{"key","name","hasIndex"}]）

    echo {"text":..., "voice":..., "rate":"+8%", "pitch":"+25Hz", "rvc":"",
          "rvcPitch":0, "indexRate":0.0, "protect":0.33} | python tts_rvc.py speak
        → stdout 输出 MP3 字节

说明：
  - 第一步用 edge-tts（py312 解释器）合成基础语音；第二步用本地 RVC 模型变声。
  - 必须在装了 torch 的解释器（AI\\venv）下运行本脚本。
  - 模型目录固定为 AI\\rvc\\models\\<key>\\<key>.pth（纯英文路径 —— faiss/librosa 对中文路径不友好）。
  - 索引（.index）默认不使用：旧版 faiss 索引在 faiss 1.15 上读不进来，不带索引也能正常变声。
"""

import glob
import json
import os
import subprocess
import shutil
import tempfile
import sys

AI = os.environ.get("DSH_READ_ALOUD_AI_DIR") or os.path.join(os.path.expanduser("~"), "AI")
PY312 = sys.executable
FFMPEG = os.environ.get("DSH_READ_ALOUD_FFMPEG") or shutil.which("ffmpeg") or os.path.join(AI, "bin", "ffmpeg.exe")
EDGE_TTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts.py")
MODELS_DIR = os.environ.get("DSH_READ_ALOUD_MODELS_DIR") or os.path.join(AI, "rvc", "models")
TMP = os.path.join(tempfile.gettempdir(), "dsh-read-aloud")

# 角色显示名
NAMES = {"aiyi": "爱音", "lenai": "乐奈", "deng": "灯", "sushi": "素世",
        "lixi": "立希", "xiangzi": "祥子", "chuhua": "初华", "nuoyemu": "若叶睦"}


def list_models():
    out = []
    if not os.path.isdir(MODELS_DIR):
        return out
    for key in sorted(os.listdir(MODELS_DIR)):
        d = os.path.join(MODELS_DIR, key)
        if not os.path.isdir(d):
            continue
        pth = os.path.join(d, key + ".pth")
        if not os.path.exists(pth):
            continue
        out.append({
            "key": key,
            "name": NAMES.get(key, key),
            "hasIndex": os.path.exists(os.path.join(d, key + ".index")),
        })
    return out


def edge_tts_mp3(text, voice, rate, pitch, volume):
    payload = json.dumps({"text": text, "voice": voice, "rate": rate, "pitch": pitch, "volume": volume}, ensure_ascii=False)
    proc = subprocess.run([PY312, EDGE_TTS, "speak"], input=payload.encode("utf-8"), capture_output=True)
    if proc.returncode != 0 or len(proc.stdout) < 512:
        # edge-tts 被限流（403）等失败 → 自动改用 Windows 自带语音兜底
        _sapi = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts_sapi.py")
        _payload = json.dumps({"text": text, "sapiRate": 2}, ensure_ascii=False)
        _sp = subprocess.run([sys.executable, _sapi, "speak"], input=_payload.encode("utf-8"), capture_output=True)
        if _sp.returncode == 0 and len(_sp.stdout) > 512:
            print("[tts_rvc] edge-tts 不可用，已改用离线语音兜底 ✓", file=sys.stderr)
            return _sp.stdout
        raise RuntimeError("edge-tts 与离线兜底均失败: " + proc.stderr.decode("utf-8", "replace")[:200])
    return proc.stdout


def convert(params):
    key = (params.get("rvc") or "").strip()
    if not key:
        return edge_tts_mp3(params.get("text", ""), params.get("voice", "zh-CN-XiaoyiNeural"),
                            params.get("rate", "+0%"), params.get("pitch", "+0Hz"), params.get("volume", "+0%"))
    os.makedirs(TMP, exist_ok=True)
    model_dir = os.path.join(MODELS_DIR, key)
    pth = os.path.join(model_dir, key + ".pth")
    if not os.path.exists(pth):
        raise RuntimeError("找不到 RVC 模型: " + pth)

    # 1) 基础语音 → wav（默认 edge-tts；sapi=true 时改用 Windows 自带语音，避免被限流）
    if params.get("sapi"):
        import json as _json
        _payload = _json.dumps({"text": params.get("text", ""), "sapiRate": params.get("sapiRate", 0)},
                               ensure_ascii=False)
        _proc = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts_sapi.py"), "speak"],
                               input=_payload.encode("utf-8"), capture_output=True)
        if _proc.returncode != 0 or len(_proc.stdout) < 512:
            raise RuntimeError("SAPI 兜底合成失败: " + _proc.stderr.decode("utf-8", "replace")[:200])
        mp3 = _proc.stdout
    else:
        mp3 = edge_tts_mp3(params.get("text", ""), params.get("voice", "zh-CN-XiaoyiNeural"),
                           params.get("rate", "+0%"), params.get("pitch", "+0Hz"), params.get("volume", "+0%"))
    raw_mp3 = os.path.join(TMP, "_rvc_in.mp3")
    in_wav = os.path.join(TMP, "_rvc_in.wav")
    with open(raw_mp3, "wb") as f:
        f.write(mp3)
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", raw_mp3, "-ar", "40000", "-ac", "1", in_wav], check=True)

    # 2) RVC 变声
    import rvc_python.infer as _ri
    _ri.download_rvc_models = lambda *a, **k: None  # 禁用联网下载（基础模型已在 base_model\）
    from rvc_python.infer import RVCInference

    rvc = RVCInference(device="cuda:0", model_path=pth, index_path="", version="v2")
    rvc.set_params(
        f0up_key=int(params.get("rvcPitch", 0) or 0),
        index_rate=0.7,  # 使用英文路径下的检索索引
        protect=float(params.get("protect", 0.33) or 0.33),
        f0method="rmvpe",
        filter_radius=3,
        resample_sr=0,
    )
    out_wav = os.path.join(TMP, "_rvc_out.wav")
    rvc.infer_file(in_wav, out_wav)
    if not os.path.exists(out_wav) or os.path.getsize(out_wav) < 2000:
        raise RuntimeError("RVC 变声未产出音频")

    # 3) 回到 mp3
    out_mp3 = os.path.join(TMP, "_rvc_out.mp3")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", out_wav, "-b:a", "96k", out_mp3], check=True)
    with open(out_mp3, "rb") as f:
        return f.read()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "speak"
    if mode == "models":
        sys.stdout.buffer.write(json.dumps(list_models(), ensure_ascii=False).encode("utf-8"))
        return
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    params = json.loads(raw or "{}")
    audio = convert(params)
    sys.stdout.buffer.write(audio)


if __name__ == "__main__":
    main()
