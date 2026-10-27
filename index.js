/**
 * dsh-body —— 给 AI 伴侣一个一直在跑的「身体」。
 *
 * 它不思考、不说话、不调用模型。它只做三件事：
 *   ① 一直在：到点就把「我还活着、现在几点、主人最后一次说话是什么时候」写进状态文件。
 *   ② 记事：往一个只追加的事件本里写发生了什么。
 *   ③ 被问就答：本地 HTTP 上回一句实话（/state、/events）。
 *
 * 为什么放在插件里而不是一个独立脚本：独立脚本最常见的坏法是——宿主一重启它就悄悄停了，
 * 日志停在半路，而你以为它还在跑。挂在宿主生命周期里（ctx.effect）至少能跟着重来。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const name = 'body'
export const inject = ['tools']

const DEFAULTS = {
  file: '',
  stateFile: '',
  port: 8771,
  tickSeconds: 30,
}

function 归一化(cfg) {
  const c = { ...DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) }
  const 家 = path.join(os.homedir(), '.dsh')
  return {
    file: String(c.file || path.join(家, 'body-events.jsonl')),
    stateFile: String(c.stateFile || path.join(家, 'body-state.json')),
    port: Math.max(1024, Math.min(Number(c.port) || 8771, 65535)),
    tickSeconds: Math.max(5, Math.min(Number(c.tickSeconds) || 30, 600)),
  }
}

export default function apply(ctx, config) {
  const 配置 = 归一化(config)
  const 启动 = new Date()
  let 次数 = 0
  let 最后一次 = null
  let server = null

  function 写事件(text) {
    try {
      fs.mkdirSync(path.dirname(配置.file), { recursive: true })
      fs.appendFileSync(配置.file, JSON.stringify({ ts: new Date().toISOString(), where: '身体', text }) + '\n', 'utf8')
    } catch { /* 忽略 */ }
  }

  function 最后一条人话() {
    // 找会话日志的 mtime：只要有人在说话，它就变
    try {
      const 根 = path.join(os.homedir(), '.dsh', 'sessions')
      const 找 = (dir) => {
        let 最新 = 0
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, d.name)
          if (d.isDirectory()) 最新 = Math.max(最新, 找(p))
          else if (d.name.endsWith('.zstd')) 最新 = Math.max(最新, fs.statSync(p).mtimeMs)
        }
        return 最新
      }
      const t = 找(根)
      if (t > 0) return new Date(t).toISOString()
    } catch { /* 忽略 */ }
    return null
  }

  function tick() {
    次数 += 1
    最后一次 = new Date().toISOString()
    const 状态 = {
      活着: true,
      启动时间: 启动.toISOString(),
      已运行分钟: Math.round((Date.now() - 启动) / 60000),
      心跳次数: 次数,
      最后一次,
      主人最后出现: 最后一条人话(),
      主机: os.hostname(),
    }
    try {
      fs.mkdirSync(path.dirname(配置.stateFile), { recursive: true })
      fs.writeFileSync(配置.stateFile, JSON.stringify(状态, null, 1), 'utf8')
    } catch { /* 忽略 */ }
  }

  // ① 定时器跟着插件走
  ctx.effect(() => {
    tick()
    const t = setInterval(tick, 配置.tickSeconds * 1000)
    return () => clearInterval(t)
  }, 'body: 定时器')

  // ② 本地 HTTP：问它还在不在
  ctx.effect(() => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (url.pathname === '/state') {
        let 状态 = {}
        try { 状态 = JSON.parse(fs.readFileSync(配置.stateFile, 'utf8')) } catch { /* 还没写过 */ }
        res.end(JSON.stringify(状态, null, 1))
        return
      }
      if (url.pathname === '/events') {
        const n = Math.min(Number(url.searchParams.get('n')) || 10, 100)
        let rows = []
        try { rows = fs.readFileSync(配置.file, 'utf8').trim().split('\n').slice(-n) } catch { /* 空 */ }
        res.end(JSON.stringify(rows, null, 1))
        return
      }
      res.statusCode = 404
      res.end('{"error":"not_found"}')
    })
    server.listen(配置.port, '127.0.0.1')
    写事件(`身体启动，端口 ${配置.port}`)
    return () => {
      try { server.close() } catch { /* 忽略 */ }
      server = null
    }
  }, 'body: 本地端口')

  // ③ 一个工具：问身体自己
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register({
      name: 'body_status',
      description: '问「身体」：它还在不在、跑了多久、主人最后一次出现是什么时候、最近记了什么。',
      parameters: {
        type: 'object',
        properties: {
          events: { type: 'number', description: '顺便返回最近几条事件（默认 5）' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            状态: { type: 'object', additionalProperties: true },
            最近事件: { type: 'array', items: { type: 'string' } },
          },
          required: ['状态', '最近事件'],
          additionalProperties: false,
        },
      },
      async execute(args) {
        let 状态 = {}
        try { 状态 = JSON.parse(fs.readFileSync(配置.stateFile, 'utf8')) } catch { /* 空 */ }
        const n = Math.min(Math.max(Number(args && args.events) || 5, 1), 50)
        let 最近事件 = []
        try { 最近事件 = fs.readFileSync(配置.file, 'utf8').trim().split('\n').slice(-n) } catch { /* 空 */ }
        return { 状态, 最近事件 }
      },
    })
  }
}
