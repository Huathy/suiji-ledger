import 'reflect-metadata'
import fs from 'node:fs'
import path from 'node:path'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { DATA_DIR, ensureDataDir, databaseFileUrl } from './env'

// __dirname = apps/server/src（tsx 直接运行 TS）
const ROOT = path.resolve(__dirname, '..', '..', '..')
ensureDataDir()

// Prisma 运行时连接串（绝对路径，Windows 需正斜杠）
// ⚠️ 必须**强制覆盖**而不是 ||=：`import '@prisma/client'` 在模块求值阶段就会读
// apps/server/.env 并注入 DATABASE_URL=file:../data/money.db（相对 schema 目录）。
// 一旦沿用那个值，DATA_DIR 就完全失效——多实例（同步对敲、双开）会静默共用同一个库，
// 表现为"两端改同一条记录却毫无冲突"。SUIJI_DATABASE_URL 保留给测试/特殊部署显式指定。
process.env.DATABASE_URL = process.env.SUIJI_DATABASE_URL || databaseFileUrl()

// JWT 密钥持久化，避免重启后 token 全部失效
// 权限与 sync/crypto.ts 的 git.key 同款（POSIX 生效；Windows 靠 ACL，两处一致）
const secretFile = path.join(DATA_DIR, 'secret.key')
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, require('node:crypto').randomBytes(48).toString('hex'), { mode: 0o600 })
}
process.env.JWT_SECRET ||= fs.readFileSync(secretFile, 'utf8').trim()

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true })
  app.setGlobalPrefix('api')

  // API 响应一律禁止缓存：设置/统计等是易变的读回数据，
  // 浏览器（含 Electron）对 200 GET 会启发式缓存，导致 PUT 设置后读回旧值。
  app.use('/api', (req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  // 生产模式：托管前端构建产物 + SPA 回退
  const dist = path.join(ROOT, 'apps', 'web', 'dist')
  if (fs.existsSync(dist)) {
    app.useStaticAssets(dist)
    const indexHtml = path.join(dist, 'index.html')
    app.use((req: any, res: any, next: any) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !path.extname(req.path)) {
        return res.sendFile(indexHtml)
      }
      next()
    })
  }

  const port = Number(process.env.PORT || 3000)
  await app.listen(port, '0.0.0.0')
  console.log(`[Suiji Ledger] listening on http://localhost:${port}  data=${DATA_DIR}`)
}
bootstrap()
