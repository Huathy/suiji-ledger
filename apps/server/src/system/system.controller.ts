import { Body, Controller, Get, Post, Put, Query, Res, UseGuards } from '@nestjs/common'
import { Response } from 'express'
import { AuthGuard } from '../auth/auth.guard'
import { SystemService } from './system.service'
import { fileStamp, stampText } from '../../../../packages/shared/src/index'

/** 导出文件名统一带 年月日-时分秒（问题 3） */
function stampedName(prefix: string, ext: string): string {
  return `${prefix}-${fileStamp()}.${ext}`
}

@Controller('system')
@UseGuards(AuthGuard)
export class SystemController {
  constructor(private svc: SystemService) {}

  @Get('health')
  health() {
    return this.svc.health()
  }

  @Get('settings')
  getSettings() {
    return this.svc.getSettings()
  }

  @Put('settings')
  putSettings(@Body() body: any) {
    return this.svc.putSettings(body?.settings || {})
  }

  @Get('matrix')
  matrix(@Query('limit') limit?: string) {
    return this.svc.matrix(limit ? Math.min(120, Number(limit) || 24) : 24)
  }

  @Get('backup')
  async backup(@Res() res: Response) {
    const data = await this.svc.backup()
    const name = stampedName('suiji-ledger-backup', 'json')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    // 备份内容里同时写入可读导出时间（本地时区），与文件名一致
    res.send(JSON.stringify({ ...data, exportedAtText: stampText() }, null, 2))
  }

  @Post('restore')
  restore(@Body() body: { mode?: string; data?: any }) {
    return this.svc.restore((body.mode as 'replace' | 'merge') || 'replace', body.data)
  }

  @Get('matrix.csv')
  async matrixCsv(@Res() res: Response) {
    const csv = await this.svc.matrixCsv()
    const name = stampedName('suiji-ledger-balance-sheet', 'csv')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(csv)
  }
}
