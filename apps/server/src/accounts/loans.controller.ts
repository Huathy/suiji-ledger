import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { LoansService } from './loans.service'
import { parseTimeSortDir } from '../../../../packages/shared/src/index'

@Controller('loans')
@UseGuards(AuthGuard)
export class LoansController {
  constructor(private svc: LoansService) {}

  @Get()
  list(@Query('dir') dir?: string) {
    return this.svc.list(parseTimeSortDir(dir))
  }

  @Post()
  create(@Body() body: any) {
    return this.svc.create(body)
  }

  @Post(':id/settle')
  settle(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.settle(id, body)
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.update(id, body)
  }

  @Post(':id/close')
  close(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.close(id, body)
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id)
  }
}
