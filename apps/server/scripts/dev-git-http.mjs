#!/usr/bin/env node
/**
 * 极简 Git Smart-HTTP 服务（**只给本地联调用**，不是生产组件）
 *
 * 为什么需要它：isomorphic-git 只走 HTTP(S)，没有 file:// 传输，
 * 想在本机做"两台设备对敲"的验收（方案 §10 M4c 的验收条件），就得有个说 smart-HTTP 的对端。
 * 这里直接把请求转给系统 git 的 upload-pack / receive-pack（stateless-rpc），够用且没有依赖。
 *
 * 用法：node apps/server/scripts/dev-git-http.mjs <仓库根目录> [端口]
 *   仓库根目录下放 `<name>.git`（bare 仓库），客户端地址 http://127.0.0.1:<port>/<name>.git
 */
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const base = path.resolve(process.argv[2] || '.')
const port = Number(process.argv[3] || 3020)

/** pkt-line 编码：长度含 4 字节长度头自身 */
const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const m = /^\/(.+?\.git)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname)
  if (!m) {
    res.writeHead(404)
    return res.end('not found')
  }
  const repo = path.join(base, decodeURIComponent(m[1]))
  if (!fs.existsSync(repo)) {
    res.writeHead(404)
    return res.end('no such repo: ' + repo)
  }
  const service = m[2] === 'info/refs' ? url.searchParams.get('service') : m[2]
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400)
    return res.end('bad service')
  }
  const cmd = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'

  if (m[2] === 'info/refs') {
    res.writeHead(200, { 'Content-Type': `application/x-${service}-advertisement`, 'Cache-Control': 'no-cache' })
    res.write(pkt(`# service=${service}\n`))
    res.write('0000')
    const p = spawn('git', [cmd, '--stateless-rpc', '--advertise-refs', repo])
    p.stdout.pipe(res)
    p.stderr.on('data', (d) => process.stderr.write('[git-adv] ' + d))
    p.on('close', () => res.end())
    return
  }

  res.writeHead(200, { 'Content-Type': `application/x-${service}-result`, 'Cache-Control': 'no-cache' })
  const p = spawn('git', [cmd, '--stateless-rpc', repo])
  req.pipe(p.stdin)
  p.stdout.pipe(res)
  p.stderr.on('data', (d) => process.stderr.write(`[${cmd}] ` + d))
  p.on('close', () => res.end())
})

server.listen(port, '127.0.0.1', () => console.log(`[git-http] http://127.0.0.1:${port}  base=${base}`))
