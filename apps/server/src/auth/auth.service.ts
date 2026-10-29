import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import * as jwt from 'jsonwebtoken'
import { PrismaService } from '../prisma.service'

const attempts = new Map<string, { count: number; resetAt: number }>()

function tooManyAttempts(key: string): boolean {
  const rec = attempts.get(key)
  if (!rec || Date.now() > rec.resetAt) return false
  return rec.count >= 10
}
function recordFail(key: string) {
  const rec = attempts.get(key)
  if (!rec || Date.now() > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: Date.now() + 10 * 60 * 1000 })
  } else rec.count++
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async hasUser() {
    return { hasUser: (await this.prisma.user.count()) > 0 }
  }

  async setup(password: string) {
    if ((await this.prisma.user.count()) > 0) throw new BadRequestException('已初始化，请直接登录')
    if (!password || password.length < 6) throw new BadRequestException('口令至少 6 位')
    const user = await this.prisma.user.create({
      data: { passwordHash: bcrypt.hashSync(password, 10), createdAt: Math.floor(Date.now() / 1000) },
    })
    return { token: this.sign(user.id) }
  }

  async login(password: string, clientKey: string) {
    if (tooManyAttempts(clientKey)) throw new UnauthorizedException('尝试次数过多，请 10 分钟后再试')
    const user = await this.prisma.user.findFirst()
    if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
      recordFail(clientKey)
      throw new UnauthorizedException('口令错误')
    }
    attempts.delete(clientKey)
    return { token: this.sign(user.id) }
  }

  async changePassword(userId: number, oldPwd: string, newPwd: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !bcrypt.compareSync(oldPwd || '', user.passwordHash)) {
      throw new BadRequestException('原口令错误')
    }
    if (!newPwd || newPwd.length < 6) throw new BadRequestException('新口令至少 6 位')
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: bcrypt.hashSync(newPwd, 10) },
    })
    return { ok: true }
  }

  sign(userId: number): string {
    return jwt.sign({ uid: userId }, process.env.JWT_SECRET!, { expiresIn: '30d' })
  }

  verify(token: string): number {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { uid: number }
    return payload.uid
  }
}
