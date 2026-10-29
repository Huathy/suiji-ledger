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
process.env.DATABASE_URL ||= databaseFileUrl()

// JWT 密钥持久化，避免重启后 token 全部失效
const secretFile = path.join(DATA_DIR, 'secret.key')
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, require('node:crypto').randomBytes(48).toString('hex'))
}
process.env.JWT_SECRET ||= fs.readFileSync(secretFile, 'utf8').trim()

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true })
  app.setGlobalPrefix('api')

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
