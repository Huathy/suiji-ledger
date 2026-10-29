import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { StatsService } from './stats.service'

@Controller('stats')
@UseGuards(AuthGuard)
export class StatsController {
  constructor(private svc: StatsService) {}

  @Get('networth')
  networth(@Query('limit') limit?: string) {
    return this.svc.networth(limit ? Math.min(120, Number(limit) || 36) : 36)
  }

  @Get('daily-avg')
  dailyAvg(@Query('limit') limit?: string) {
    return this.svc.dailyAvg(limit ? Math.min(60, Number(limit) || 12) : 12)
  }

  @Get('type-contribution')
  typeContribution(@Query('limit') limit?: string) {
    return this.svc.typeContribution(limit ? Math.min(60, Number(limit) || 12) : 12)
  }

  @Get('interval')
  interval(@Query('from') from: string, @Query('to') to: string) {
    return this.svc.interval(from || '', to || '')
  }
}
