# 🔊 DSH Read Aloud（DSH 朗读插件）

让 DeepSeek Harness（DSH）具备**语音朗读**能力：把聊天文字用多种声线读出来，支持**自动朗读**、**RVC 本地声线变声**、以及**离线兜底**。

> 本插件全程本地合成，**不消耗任何 LLM token**，也不需要 API Key。

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🗣️ **一键朗读** | 点对话输入框左侧的「朗读」按钮，朗读你选中的文字；没选中时朗读最新一条回复 |
| 🤖 **自动朗读** | 打开后，助手每生成一条回复就自动读出来（带 Markdown 清洗 + 1.3 秒防抖） |
| ⌨️ **快捷键** | `Alt + R` 朗读 / 停止（有选中文本时优先念选中的） |
| 🎚️ **海量音色** | 内置 13 个预设 + 322 个 edge-tts 音色可选，可调语速 / 音调 / 音量 |
| 🎤 **RVC 声线** | 支持本地 RVC 模型变声（`.pth` 文件），变调 ±12 半音，内置若干角色示例条目 |
| 🔌 **离线兜底** | edge-tts 被限流/不可用时，自动切换到 Windows 自带语音（SAPI） |
| 💾 **磁盘缓存** | 合成结果按内容哈希缓存，重复内容不重复请求 |
| 🔒 **隐私安全** | 不含任何硬编码本机路径，路径全部通过环境变量 / 自动探测配置 |

---

## 🚀 安装

1. 把本目录放入 DSH 的插件目录：`~/.dsh/profiles/<你的 profile>/node_modules/dsh-read-aloud/`
2. 在 DSH 的 `cordis.patch.yml` 中注册（或通过插件管理启用）
3. 依赖：Python 3.9+（需 `edge-tts`）、可选的 `ffmpeg`

```bash
pip install edge-tts
```

---

## ⚙️ 配置（环境变量，均可选）

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `DSH_READ_ALOUD_PYTHON` | Python 解释器（宿主调用用） | `python` |
| `DSH_READ_ALOUD_AI_DIR` | 工作目录（放 ffmpeg / 模型） | `~/AI` |
| `DSH_READ_ALOUD_FFMPEG` | ffmpeg 路径 | 自动探测 |
| `DSH_READ_ALOUD_MODELS_DIR` | RVC 模型目录 | `~/AI/rvc/models` |

### RVC 声线（可选）

把 RVC 模型放到模型目录下（每个声线一个子目录，`<key>/<key>.pth`）：

```
~/AI/rvc/models/
  ├── aiyi/aiyi.pth        ← 对应下拉里的「爱音」示例条目
  └── ...
```

下拉里的角色条目**只是示例**（模型文件需自备）。你也可以改 `client.js` 里的 `RVC_MODELS` 列表，或删掉示例条目。

---

## 🛠️ 工作原理

```
聊天文字
  ↓ ① edge-tts 合成基础语音（或离线 SAPI 兜底）
  ↓ ② （可选）RVC 变声为目标声线
  ↓ ③ ffmpeg 转码 → 浏览器播放
```

---

## 📄 License

MIT