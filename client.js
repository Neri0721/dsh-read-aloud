/**
 * dsh-read-aloud — 客户端半边（Client half）
 *
 * 两处 UI：
 *   1) conversation.input.left  → 「朗读」按钮（点一下朗读最新回复 / 选中文本，再点停止）
 *   2) settings.section         → 「朗读」设置页：322 个音色可选（中文优先）+ 萝莉音等预设
 *                                + 语速/音调/音量微调 + 试听
 *
 * 音频来自本包宿主半边的本地路由：
 *   GET /dsh-read-aloud/speak?text=...&voice=...&rate=+8%&pitch=+25Hz
 *   GET /dsh-read-aloud/voices
 *
 * 文本来源（三级兜底）：
 *   ① 页面选中文本  ② [data-chat-flow] 里最后一个像回复的块  ③ 提示用户先选中
 */

window.__ModuleLoader__.load({
  id: 'dsh-read-aloud',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------------ 常量 */

    const API = '/dsh-read-aloud'
    const LS_KEY = 'dsh-read-aloud:settings'
    const SAMPLE = '你好呀，我是你的朗读助手，这段是试听效果。'

    /** RVC 角色声线（来自用户桌面 VCC&RVCModel 的 MyGO 全员模型） */
    const RVC_MODELS = [
      { key: '', name: '原生（edge-tts 音色）' },
      { key: 'aiyi', name: '⭐ 爱音' },
      { key: 'lenai', name: '乐奈' },
      { key: 'deng', name: '灯' },
      { key: 'sushi', name: '素世' },
      { key: 'lixi', name: '立希' },
      { key: 'xiangzi', name: '祥子' },
      { key: 'chuhua', name: '初华' },
      { key: 'nuoyemu', name: '若叶睦' },
    ]

    /** 音色预设：萝莉音放在最前面（用户偏好），其余为常用风格。 */
    const PRESETS = [
      { id: 'loli-sweet', label: '⭐ 萝莉音（甜）', voice: 'zh-CN-XiaoyiNeural', rate: 8, pitch: 25, volume: 100 },
      { id: 'loli-soft', label: '⭐ 萝莉音（软糯）', voice: 'zh-CN-XiaoyiNeural', rate: 3, pitch: 18, volume: 95 },
      { id: 'loli-genki', label: '萝莉音（元气）', voice: 'zh-CN-XiaoyiNeural', rate: 15, pitch: 30, volume: 100 },
      { id: 'girl-warm', label: '少女音（温柔）', voice: 'zh-CN-XiaoxiaoNeural', rate: 5, pitch: 10, volume: 100 },
      { id: 'sister', label: '御姐音（沉稳）', voice: 'zh-CN-XiaoxiaoNeural', rate: -5, pitch: -8, volume: 100 },
      { id: 'boy', label: '正太音（男孩）', voice: 'zh-CN-YunxiaNeural', rate: 8, pitch: 20, volume: 100 },
      { id: 'youth', label: '青年音（阳光）', voice: 'zh-CN-YunxiNeural', rate: 5, pitch: 5, volume: 100 },
      { id: 'news', label: '播音腔（新闻）', voice: 'zh-CN-YunyangNeural', rate: 0, pitch: 0, volume: 100 },
      { id: 'dongbei', label: '东北话（整活）', voice: 'zh-CN-liaoning-XiaobeiNeural', rate: 5, pitch: 5, volume: 100 },
      { id: 'shaanxi', label: '陕西话（整活）', voice: 'zh-CN-shaanxi-XiaoniNeural', rate: 5, pitch: 5, volume: 100 },
      { id: 'cantonese', label: '粤语', voice: 'zh-HK-HiuMaanNeural', rate: 0, pitch: 0, volume: 100 },
      { id: 'taiwan', label: '台湾腔', voice: 'zh-TW-HsiaoChenNeural', rate: 0, pitch: 5, volume: 100 },
      { id: 'raw', label: '原味（不加修饰）', voice: 'zh-CN-XiaoyiNeural', rate: 0, pitch: 0, volume: 100 },
    ]

    const DEFAULT_SETTINGS = {
      enabled: true,
      voice: 'zh-CN-XiaoyiNeural',
      rate: 8,
      pitch: 25,
      volume: 100,
      presetId: 'loli-sweet',
      autoRead: true,
      autoReadMigrated: true,
      rvc: '',
      sbv2: '',
      sbv2Style: 'Neutral',
      rvcPitch: 0,
      maxChars: 2000,
    }

    /* ------------------------------------------------------------------ 设置存取 */

    function loadSettings() {
      let merged
      try {
        const raw = window.localStorage.getItem(LS_KEY)
        if (!raw) return { ...DEFAULT_SETTINGS }
        const parsed = JSON.parse(raw)
        merged = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
      } catch {
        return { ...DEFAULT_SETTINGS }
      }
      // 一次性迁移：升级到"默认自动朗读"时，把老配置也打开（之后用户手动关掉就不会再强行打开）
      if (merged.autoReadMigrated !== true) {
        merged.autoRead = true
        merged.autoReadMigrated = true
        saveSettings(merged)
      }
      return merged
    }

    function saveSettings(next) {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(next))
      } catch {
        /* 隐私模式等场景忽略 */
      }
    }

    /** 数值 → edge-tts 参数字符串 */
    function rateArg(v) {
      const n = Math.max(-50, Math.min(100, Number(v) || 0))
      return (n >= 0 ? '+' : '') + n + '%'
    }
    function pitchArg(v) {
      const n = Math.max(-50, Math.min(50, Number(v) || 0))
      return (n >= 0 ? '+' : '') + n + 'Hz'
    }
    function volumeArg(v) {
      const n = Math.max(0, Math.min(100, Number(v) || 100))
      return (n >= 100 ? '+0%' : '-' + (100 - n) + '%')
    }

    /* ------------------------------------------------------------------ 朗读引擎（模块级单例） */

    const player = {
      audio: null,
      state: 'idle', // idle | loading | playing
      listeners: new Set(),
      subscribe(fn) {
        player.listeners.add(fn)
        return () => player.listeners.delete(fn)
      },
      setState(next) {
        if (player.state === next) return
        player.state = next
        for (const fn of player.listeners) {
          try {
            fn(next)
          } catch {
            /* 单个订阅者出错不影响其他 */
          }
        }
      },
      stop() {
        if (player.audio) {
          try {
            player.audio.pause()
          } catch {
            /* 忽略 */
          }
          player.audio = null
        }
        player.setState('idle')
      },
      async speak(text, settings) {
        const body = (text || '').trim()
        if (!body) return false
        player.stop()
        player.setState('loading')
        const clipped = body.slice(0, Math.max(100, Number(settings.maxChars) || 1200))
        const url =
          API +
          '/speak?voice=' + encodeURIComponent(settings.voice) +
          '&rate=' + encodeURIComponent(rateArg(settings.rate)) +
          '&pitch=' + encodeURIComponent(pitchArg(settings.pitch)) +
          '&volume=' + encodeURIComponent(volumeArg(settings.volume)) +
          '&rvc=' + encodeURIComponent((settings.rvc || '').includes(':') ? '' : (settings.rvc || '')) +
          '&sbv2=' + encodeURIComponent((settings.rvc || '').includes(':') ? (settings.rvc || '').split(':')[1] : '') +
          '&kana=' + encodeURIComponent((settings.rvc || '').startsWith('sbv2kana:') ? '1' : '') +
          '&style=' + encodeURIComponent(settings.sbv2Style || 'Neutral') +
          '&rvcPitch=' + encodeURIComponent(String(settings.rvcPitch || 0)) +
          '&text=' + encodeURIComponent(clipped)
        const audio = new Audio(url)
        player.audio = audio
        audio.addEventListener('ended', () => player.setState('idle'))
        audio.addEventListener('error', () => player.setState('idle'))
        try {
          await audio.play()
          player.setState('playing')
          return true
        } catch (error) {
          player.setState('idle')
          console.error('[dsh-read-aloud] 播放失败:', error)
          return false
        }
      },
    }

    /* ------------------------------------------------------------------ 文本提取（三级兜底） */

    /** 过滤掉界面按钮文字等噪声行 */
    const NOISE = new Set([
      '复制', '重试', '编辑', '删除', '朗读', '停止', '展开', '收起', 'Copy', 'Retry', 'Edit', 'Delete',
      '思考过程', '工具调用', '用时', '完成', '运行', '查看详情',
    ])

    /** 去掉 Markdown 里"念出来很怪"的东西：代码块、表格竖线、星号、链接地址等 */
    function stripMarkdown(input) {
      return String(input || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*[-:|\s]{3,}$/gm, ' ')
        .replace(/\|/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
    }

    function cleanText(raw) {
      return stripMarkdown(raw)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !NOISE.has(line))
        .join('\n')
        .trim()
    }

    /** ② 对话流里最后一个像"回复"的块 */
    function readLastReply() {
      const flow = document.querySelector('[data-chat-flow]')
      if (!flow) return ''
      const blocks = Array.from(flow.querySelectorAll(':scope > *')).filter(
        (el) => el instanceof HTMLElement && !el.hasAttribute('data-slot'),
      )
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const text = cleanText(blocks[i].innerText)
        if (text.length >= 30) return text
      }
      const whole = cleanText(flow.innerText)
      return whole.length >= 30 ? whole : ''
    }

    /** ① 选中文本 → ② 最后回复 → '' */
    function resolveText() {
      try {
        const sel = window.getSelection()
        const picked = cleanText(sel ? sel.toString() : '')
        if (picked.length >= 2) return { text: picked, from: 'selection' }
      } catch {
        /* 忽略 */
      }
      const last = readLastReply()
      if (last) return { text: last, from: 'reply' }
      return { text: '', from: 'none' }
    }

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.ral-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;transition:border-color .12s ease,color .12s ease}
.ral-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.ral-btn.is-on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ral-btn .ral-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:ral-pulse .9s ease-in-out infinite}
@keyframes ral-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.ral-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.ral-panel .ral-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ral-panel .ral-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}
.ral-panel select,.ral-panel input[type=range]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 8px;font-size:13px}
.ral-panel input[type=range]{padding:0;border:none;background:transparent;width:190px}
.ral-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}
.ral-panel button:hover{border-color:var(--dsw-alias-brand-primary)}
.ral-panel button.ral-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground)}
.ral-panel .ral-note{padding:7px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.ral-panel .ral-val{min-width:52px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ral-panel .ral-presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.ral-panel .ral-preset{text-align:left;padding:7px 10px;border-radius:8px;font-size:12.5px}
.ral-panel .ral-preset.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
`

    /* ------------------------------------------------------------------ 朗读按钮 */

    function usePlayerState() {
      const [state, setState] = React.useState(player.state)
      React.useEffect(() => player.subscribe(setState), [])
      return state
    }

    function ReadButton() {
      const state = usePlayerState()
      const settings = loadSettings()
      const onClick = async () => {
        if (player.state !== 'idle') {
          player.stop()
          return
        }
        const { text, from } = resolveText()
        if (!text) {
          window.alert('没有可朗读的文本：先选中一段文字，或等助手回复完成后再点。')
          return
        }
        const ok = await player.speak(text, settings)
        if (!ok) window.alert('朗读失败：宿主半边或 edge-tts 可能没就绪，看控制台 [dsh-read-aloud]。')
        else if (from === 'reply') console.log('[dsh-read-aloud] 已朗读最新回复，' + text.length + ' 字')
      }
      const label = state === 'loading' ? '合成中' : state === 'playing' ? '停止' : '朗读'
      return h(
        'button',
        {
          className: 'ral-btn' + (state === 'playing' ? ' is-on' : ''),
          title: '朗读选中文本或最新回复（再点一次停止）',
          onClick,
        },
        state === 'playing' ? h('span', { className: 'ral-dot' }) : h('span', null, '🔊'),
        h('span', null, label),
      )
    }

    /* ------------------------------------------------------------------ 设置页 */

    function SettingsPanel() {
      const [settings, setSettings] = React.useState(loadSettings)
      const [voices, setVoices] = React.useState([])
      const [loadError, setLoadError] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(API + '/voices')
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((list) => {
            if (alive && Array.isArray(list)) setVoices(list)
          })
          .catch((error) => {
            if (alive) setLoadError(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [])

      const update = (patch) => {
        const next = { ...settings, ...patch }
        setSettings(next)
        saveSettings(next)
      }

      const applyPreset = (preset) => {
        update({ presetId: preset.id, voice: preset.voice, rate: preset.rate, pitch: preset.pitch, volume: preset.volume })
        player.speak(SAMPLE, { ...settings, voice: preset.voice, rate: preset.rate, pitch: preset.pitch, volume: preset.volume })
      }

      const zhVoices = voices.filter((v) => v.zh)
      const otherVoices = voices.filter((v) => !v.zh)
      const byLocale = (list) => {
        const map = new Map()
        for (const v of list) {
          if (!map.has(v.locale)) map.set(v.locale, [])
          map.get(v.locale).push(v)
        }
        return Array.from(map.entries()).map(([locale, items]) =>
          h(
            'optgroup',
            { key: locale, label: locale },
            items.map((v) => h('option', { key: v.id, value: v.id }, v.id + '  （' + (v.gender === 'Female' ? '女' : '男') + '·' + v.name + '）')),
          ),
        )
      }

      const slider = (key, label, min, max, unit) =>
        h(
          'div',
          { className: 'ral-row' },
          h('span', { style: { minWidth: '76px' } }, label),
          h('input', {
            type: 'range',
            min,
            max,
            value: settings[key],
            onChange: (e) => update({ [key]: Number(e.target.value) }),
          }),
          h('span', { className: 'ral-val' }, String(settings[key]) + unit),
        )

      return h(
        'div',
        { className: 'ral-panel' },
        h('div', { className: 'ral-note' }, [
          h('div', { key: 'a' }, '🔊 朗读插件：点对话输入框左侧的「朗读」按钮，会朗读你选中的文字；没选中时朗读最新一条回复。'),
          h('div', { key: 'b' }, '音色由微软 Edge 朗读接口（edge-tts）合成，无需 API Key、不额外花钱；合成结果会缓存到本地，重复内容不会重复请求。'),
        ]),
        loadError
          ? h('div', { className: 'ral-note', style: { borderColor: 'var(--dsw-alias-border-l1)' } }, '音色清单加载失败：' + loadError + '（可在控制台看 /dsh-read-aloud/voices）')
          : null,
        h('div', { className: 'ral-title' }, '音色预设（萝莉音在最前）'),
        h(
          'div',
          { className: 'ral-presets' },
          PRESETS.map((p) =>
            h(
              'button',
              {
                key: p.id,
                className: 'ral-preset' + (settings.presetId === p.id ? ' on' : ''),
                onClick: () => applyPreset(p),
              },
              p.label,
            ),
          ),
        ),
        h('div', { className: 'ral-title' }, '音色（共 ' + voices.length + ' 个，中文 ' + zhVoices.length + ' 个）'),
        h(
          'div',
          { className: 'ral-row' },
          h(
            'select',
            {
              value: settings.voice,
              style: { minWidth: '330px' },
              onChange: (e) => update({ voice: e.target.value, presetId: '' }),
            },
            h('optgroup', { label: '中文（优先）' }, zhVoices.map((v) => h('option', { key: v.id, value: v.id }, v.id + '  （' + (v.gender === 'Female' ? '女' : '男') + '·' + v.name + '）'))),
            byLocale(otherVoices),
          ),
          h('button', { onClick: () => player.speak(SAMPLE, settings) }, '试听'),
          h('button', { onClick: () => player.stop() }, '停止'),
        ),
        h('div', { className: 'ral-title' }, '微调'),
        slider('rate', '语速', -50, 100, '%'),
        slider('pitch', '音调', -50, 50, 'Hz'),
        slider('volume', '音量', 0, 100, ''),
        h('div', { className: 'ral-title' }, '其他'),
        h(
          'div',
          { className: 'ral-row' },
          h('label', null, [
            h('input', { key: 'c', type: 'checkbox', checked: !!settings.enabled, onChange: (e) => update({ enabled: e.target.checked }) }),
            h('span', { key: 't', style: { marginLeft: '6px' } }, '在输入框显示朗读按钮'),
          ]),
        ),
        h(
          'div',
          { className: 'ral-row' },
          h('label', null, [
            h('input', { key: 'ar', type: 'checkbox', checked: !!settings.autoRead, onChange: (e) => update({ autoRead: e.target.checked }) }),
            h('span', { key: 'art', style: { marginLeft: '6px' } }, '新回复写完自动朗读（v0.2）'),
          ]),
        ),
        h('div', { className: 'ral-row' }, h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '快捷键：Alt + R 朗读 / 停止（有选中文本时优先念选中的）')),
        h('div', { className: 'ral-title' }, '声线来源（RVC 角色声线，首次合成稍慢）'),
        h(
          'div',
          { className: 'ral-row' },
          h(
            'select',
            { value: settings.rvc || '', style: { minWidth: '200px' }, onChange: (e) => update({ rvc: e.target.value }) },
            RVC_MODELS.map((m) => h('option', { key: m.key || 'none', value: m.key }, m.name)),
          ),
          h('button', { onClick: () => player.speak(SAMPLE, settings) }, '按当前设置试听'),
        ),
        h(
          'div',
          { className: 'ral-row' },
          h('span', null, '变调'),
          h('input', { type: 'range', min: -12, max: 12, value: settings.rvcPitch || 0, onChange: (e) => update({ rvcPitch: Number(e.target.value) }) }),
          h('span', { className: 'ral-val' }, String(settings.rvcPitch || 0) + ' 半音'),
        ),
        h(
          'div',
          { className: 'ral-row' },
          h('span', null, '单次最多朗读'),
          h('input', {
            type: 'range',
            min: 200,
            max: 4000,
            step: 100,
            value: settings.maxChars,
            onChange: (e) => update({ maxChars: Number(e.target.value) }),
          }),
          h('span', { className: 'ral-val' }, settings.maxChars + ' 字'),
        ),
        h('div', { className: 'ral-row' }, h('button', { className: 'ral-primary', onClick: () => update({ ...DEFAULT_SETTINGS, presetId: DEFAULT_SETTINGS.presetId }) }, '恢复默认（萝莉音）')),
      )
    }

    /* ------------------------------------------------------------------ 挂载 */

    function apply(ctx) {
      const slots = ctx.get('slots')
      const styles = ctx.get('styles')
      if (styles && typeof styles.insert === 'function') styles.insert(CSS)
      else document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }))

      if (!slots) {
        console.error('[dsh-read-aloud] 拿不到 slots 服务')
        return
      }
      slots.inject('conversation.input.left', () =>
        slots.register({ name: 'conversation.input.left', id: 'read-aloud', order: 6, label: '朗读' }, () =>
          h(ReadButton),
        ),
      )
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'read-aloud', order: 120, label: '朗读' }, () =>
          h(SettingsPanel),
        ),
      )

      // ── v0.2 自动朗读：盯着对话流，识别"新回复写完"后自动念 ──
      ctx.effect(() => {
        let observer = null
        let debounce = null
        let lastHash = ''
        const pick = () => {
          const current = loadSettings()
          if (!current.enabled || !current.autoRead) return
          const text = readLastReply()
          if (!text || text.length < 20) return
          const hash = text.length + '|' + text.slice(0, 60) + '|' + text.slice(-60)
          if (hash === lastHash) return
          lastHash = hash
          player.speak(text, current)
        }
        const attach = () => {
          const flow = document.querySelector('[data-chat-flow]')
          if (!flow || observer) return
          observer = new MutationObserver(() => {
            if (debounce) clearTimeout(debounce)
            debounce = setTimeout(pick, 1300)
          })
          observer.observe(flow, { childList: true, subtree: true, characterData: true })
        }
        const retry = setInterval(attach, 1500)
        attach()
        return () => {
          if (debounce) clearTimeout(debounce)
          if (observer) observer.disconnect()
          clearInterval(retry)
        }
      }, 'dsh-read-aloud: 自动朗读观察器')

      // ── v0.2 快捷键：Alt+R 朗读 / 停止 ──
      ctx.effect(() => {
        const onKey = (event) => {
          const current = loadSettings()
          if (!current.enabled) return
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (String(event.key).toLowerCase() !== 'r') return
          event.preventDefault()
          if (player.state !== 'idle') {
            player.stop()
            return
          }
          const found = resolveText()
          if (found.text) player.speak(found.text, loadSettings())
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, 'dsh-read-aloud: 快捷键 Alt+R')
      console.log('[dsh-read-aloud] 客户端已挂载：朗读按钮 + 设置页')
    }

    function inject() {
      return []
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { rateArg, pitchArg, volumeArg, cleanText, PRESETS, DEFAULT_SETTINGS }
    return module.exports
  },
})
