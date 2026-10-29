import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { MonthsService } from './months.service'

@Controller()
@UseGuards(AuthGuard)
export class MonthsController {
  constructor(private svc: MonthsService) {}

  @Get('months')
  months(@Query('limit') limit?: string) {
    return this.svc.months(limit ? Math.min(120, Number(limit) || 60) : 60)
  }

  @Get('month/:ym')
  detail(@Param('ym') ym: string) {
    return this.svc.detail(ym)
  }

  @Post('month/:ym/entry')
  addEntry(@Param('ym') ym: string, @Body() body: any) {
    return this.svc.addEntry(ym, body)
  }

  @Get('search')
  search(@Query('q') q: string, @Query('minYuan') minYuan: string, @Query('maxYuan') maxYuan: string) {
    return this.svc.search(q || '', minYuan ? Number(minYuan) : null, maxYuan ? Number(maxYuan) : null)
  }

  @Post('reconcile')
  reconcile(@Body() body: any) {
    return this.svc.reconcile(body)
  }

  @Post('import/snapshots')
  importSnapshots(@Body() body: any) {
    return this.svc.importSnapshots(body)
  }

  @Patch('month/:ym/entry/:id')
  updateEntry(@Param('ym') ym: string, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateEntry(ym, Number(id), body)
  }

  @Delete('month/:ym/entry/:id')
  deleteEntry(@Param('ym') ym: string, @Param('id') id: string) {
    return this.svc.deleteEntry(ym, Number(id))
  }
}
