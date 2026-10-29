import { Body, Controller, Get, Post, Put, Query, Res, UseGuards } from '@nestjs/common'
import { Response } from 'express'
import { AuthGuard } from '../auth/auth.guard'
import { SystemService } from './system.service'

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
    const name = `suiji-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(JSON.stringify(data, null, 2))
  }

  @Post('restore')
  restore(@Body() body: { mode?: string; data?: any }) {
    return this.svc.restore((body.mode as 'replace' | 'merge') || 'replace', body.data)
  }

  @Get('matrix.csv')
  async matrixCsv(@Res() res: Response) {
    const csv = await this.svc.matrixCsv()
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="suiji-ledger-balance-sheet.csv"')
    res.send(csv)
  }
}
