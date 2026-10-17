/**
 * dsh-read-aloud — 宿主半边（Host half）
 *
 * 职责：把 edge-tts 的语音合成能力暴露成两个本地 HTTP 路由，供客户端半边调用。
 *
 *   GET /dsh-read-aloud/voices
 *       → application/json：全部音色清单（中文优先，带 zh 标记）
 *
 *   GET /dsh-read-aloud/speak?text=...&voice=...&rate=+8%&pitch=+25Hz&volume=+0%
 *       → audio/mpeg：合成后的 MP3（同一段文本+同一组参数命中磁盘缓存，不重复合成）
 *
 * 设计要点：
 *   - 合成靠 edge-tts（微软 Edge 朗读的免费在线接口），调用的是本机 Python；
 *   - 缓存目录 ~/.dsh/read-aloud-cache，键 = sha1(voice|rate|pitch|volume|text)；
 *   - 文本上限 4000 字，避免一次朗读把队列占满；
 *   - 纯 insert 挂载，路由注册用 ctx.effect 以便插件卸载时自动清理。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const name = 'dsh-read-aloud'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

/** Python 解释器：优先环境变量，其次本机已装 edge-tts 的解释器。 */
const PYTHON_CANDIDATES = [process.env.DSH_READ_ALOUD_PYTHON || 'python'].filter(Boolean)

const MAX_CHARS = 4000
const CACHE_DIR = join(homedir(), '.dsh', 'read-aloud-cache')

/** RVC 变声脚本需要 torch，必须跑在装了 torch 的解释器（AI\venv）上。 */
const PY_RVC = process.env.DSH_READ_ALOUD_PYTHON || 'python'

/** 跑一次 Python 助手：resolve(reject) 收 stdout 的 Buffer。 */
function runPython(args, stdinText, pythonOverride) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child = null
    let lastError = null
    const candidates = pythonOverride ? [pythonOverride] : PYTHON_CANDIDATES
    for (const exe of candidates) {
      try {
        child = spawn(exe, [join(HERE, 'tts.py'), ...args], { windowsHide: true })
        break
      } catch (error) {
        lastError = error
        child = null
      }
    }
    if (!child) {
      rejectPromise(lastError ?? new Error('找不到 Python 解释器'))
      return
    }
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (error) => rejectPromise(error))
    child.on('close', (code) => {
      if (code === 0 && out.length > 0) resolvePromise(Buffer.concat(out))
      else rejectPromise(new Error('tts.py 退出码 ' + code + '：' + Buffer.concat(err).toString('utf8').slice(0, 400)))
    })
    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.end(Buffer.from(stdinText, 'utf8'))
    } else {
      child.stdin.end()
    }
  })
}

/** 跑 RVC 变声助手（tts_rvc.py）：同样返回 stdout 的 Buffer。 */
/** 通用：跑插件目录下的 Python 助手脚本（RVC / SBV2 共用）。 */
function runPyScript(scriptName, args, stdinText) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child = null
    try {
      child = spawn(PY_RVC, [join(HERE, scriptName), ...args], { windowsHide: true })
    } catch (error) {
      rejectPromise(error)
      return
    }
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (error) => rejectPromise(error))
    child.on('close', (code) => {
      if (code === 0 && out.length > 0) resolvePromise(Buffer.concat(out))
      else rejectPromise(new Error(scriptName + ' 退出码 ' + code + '：' + Buffer.concat(err).toString('utf8').slice(-400)))
    })
    child.stdin.end(Buffer.from(stdinText ?? '', 'utf8'))
  })
}

function runSbv2(args, stdinText) {
  return runPyScript('tts_sbv2.py', args, stdinText)
}

/** 离线兜底：Windows 自带语音（SAPI）合成。 */
function runSapi(args, stdinText) {
  return runPyScript('tts_sapi.py', args, stdinText)
}

function runRvc(args, stdinText) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child = null
    try {
      child = spawn(PY_RVC, [join(HERE, 'tts_rvc.py'), ...args], { windowsHide: true })
    } catch (error) {
      rejectPromise(error)
      return
    }
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (error) => rejectPromise(error))
    child.on('close', (code) => {
      if (code === 0 && out.length > 0) resolvePromise(Buffer.concat(out))
      else rejectPromise(new Error('tts_rvc.py 退出码 ' + code + '：' + Buffer.concat(err).toString('utf8').slice(-400)))
    })
    child.stdin.end(Buffer.from(stdinText ?? '', 'utf8'))
  })
}

/** 合成（带磁盘缓存）。 */
async function synthesize({ text, voice, rate, pitch, volume, rvc, rvcPitch, protect, sbv2, style, length, noise, noiseW, kana }) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const key = createHash('sha1')
    .update([voice, rate, pitch, volume, rvc, rvcPitch, protect, sbv2, style, length, noise, noiseW, kana, text].join('\u0000'))
    .digest('hex')
  const file = join(CACHE_DIR, key + '.mp3')
  if (existsSync(file)) {
    try {
      const cached = readFileSync(file)
      if (cached.length > 512) return cached
      unlinkSync(file)
    } catch {
      /* 缓存坏了就重新合成 */
    }
  }
  const payload = JSON.stringify({ text, voice, rate, pitch, volume, rvc, rvcPitch, protect, sbv2, style, length, noise, noiseW, kana })
  const audio = sbv2
    ? await runSbv2(['speak'], payload)
    : rvc
      ? await runRvc(['speak'], payload)
      : await runPython(['speak'], payload)
  if (audio.length > 512) {
    try {
      writeFileSync(file, audio)
    } catch {
      /* 缓存写失败不影响本次播放 */
    }
  }
  return audio
}

function parseQuery(url) {
  const q = url.indexOf('?')
  const params = new URLSearchParams(q >= 0 ? url.slice(q + 1) : '')
  const pick = (k, fallback) => {
    const v = params.get(k)
    return v === null || v === '' ? fallback : v
  }
  return {
    text: pick('text', '').slice(0, MAX_CHARS),
    voice: pick('voice', 'zh-CN-XiaoyiNeural'),
    rate: pick('rate', '+0%'),
    pitch: pick('pitch', '+0Hz'),
    volume: pick('volume', '+0%'),
    rvc: pick('rvc', ''),
    sbv2: pick('sbv2', ''),
    kana: pick('kana', ''),
    style: pick('style', 'Neutral'),
    length: pick('length', '1.0'),
    noise: pick('noise', '0.6'),
    noiseW: pick('noiseW', '0.8'),
    rvcPitch: pick('rvcPitch', '0'),
    protect: pick('protect', '0.33'),
  }
}

export function apply(ctx, config) {
  const webServer = ctx.webServer

  ctx.effect(() => webServer.register({
    path: '/dsh-read-aloud/voices',
    handler: async (req, res) => {
      try {
        const json = await runPython(['voices'])
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        })
        res.end(json)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'dsh-read-aloud: /dsh-read-aloud/voices')

  ctx.effect(() => webServer.register({
    path: '/dsh-read-aloud/speak',
    handler: async (req, res) => {
      const params = parseQuery(req.url || '')
      if (!params.text.trim()) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('缺少 text 参数')
        return
      }
      try {
        const audio = await synthesize(params)
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(audio.length),
          'Cache-Control': 'no-store',
        })
        res.end(audio)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('合成失败: ' + (error instanceof Error ? error.message : String(error)))
      }
    },
  }), 'dsh-read-aloud: /dsh-read-aloud/speak')

  ctx.effect(() => webServer.register({
    path: '/dsh-read-aloud/rvc-models',
    handler: async (req, res) => {
      try {
        const json = await runRvc(['models'], '')
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' })
        res.end(json)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'dsh-read-aloud: /dsh-read-aloud/rvc-models')
  console.log('[dsh-read-aloud] 已注册路由: /dsh-read-aloud/voices , /dsh-read-aloud/speak（缓存目录 ' + CACHE_DIR + '）')
}
