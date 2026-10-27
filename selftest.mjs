// 离线自测：假装宿主跑一遍，不碰 DSH
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import apply from 'file:///D:/fish-widget/plugins/dsh-body/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'body-'))
const cleanups = []
let tool = null
const ctx = {
  effect(fn) { cleanups.push(fn()) },
  tools: { register(t) { tool = t } },
}

apply(ctx, {
  file: path.join(tmp, 'events.jsonl'),
  stateFile: path.join(tmp, 'state.json'),
  port: 18771,
  tickSeconds: 5,
})

assert.ok(tool && tool.name === 'body_status', '工具没注册')
assert.ok(fs.existsSync(path.join(tmp, 'state.json')), '状态文件没写')

const r = await tool.execute({ events: 3 })
assert.equal(r.状态.活着, true, '状态里没有「活着」')
assert.ok(Array.isArray(r.最近事件), '事件不是数组')

// 本地端口能答
const res = await fetch('http://127.0.0.1:18771/state')
assert.equal(res.status, 200)
const body = await res.json()
assert.equal(body.活着, true)

const res2 = await fetch('http://127.0.0.1:18771/events?n=2')
assert.equal(res2.status, 200)

for (const c of cleanups) { try { c() } catch {} }
fs.rmSync(tmp, { recursive: true, force: true })
console.log('全部通过：工具注册 / 状态落盘 / 端口应答 / 事件读取')
