import { Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { RecycleService } from './recycle.service'
import { parseTimeSortDir } from '../../../../packages/shared/src/index'

@Controller('recycle')
@UseGuards(AuthGuard)
export class RecycleController {
  constructor(private svc: RecycleService) {}

  @Get()
  list(@Query('dir') dir?: string) {
    return this.svc.list(parseTimeSortDir(dir))
  }

  @Post(':id/restore')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.svc.restore(id)
  }

  @Delete(':id')
  removeForever(@Param('id', ParseIntPipe) id: number) {
    return this.svc.removeForever(id)
  }

  @Delete()
  clear() {
    return this.svc.clear()
  }
}
