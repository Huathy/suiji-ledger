import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { Request } from 'express'
import { AuthService } from './auth.service'
import { AuthGuard } from './auth.guard'
import { PrismaService } from '../prisma.service'

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService) {}

  @Get('bootstrap')
  async bootstrap() {
    return this.auth.hasUser()
  }

  @Post('setup')
  setup(@Body() body: { password?: string }) {
    return this.auth.setup(body.password || '')
  }

  @Post('login')
  login(@Body() body: { password?: string }, @Req() req: Request) {
    const key = req.ip || 'unknown'
    return this.auth.login(body.password || '', key)
  }

  @Post('password')
  @UseGuards(AuthGuard)
  changePassword(@Req() req: any, @Body() body: { old?: string; new?: string }) {
    return this.auth.changePassword(req.userId, body.old || '', body.new || '')
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() req: any) {
    const accounts = await this.prisma.account.count()
    const snapshots = await this.prisma.monthlySnapshot.count()
    return { userId: req.userId, accounts, snapshots }
  }
}
