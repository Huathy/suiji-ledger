import { Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { RecycleService } from './recycle.service'

@Controller('recycle')
@UseGuards(AuthGuard)
export class RecycleController {
  constructor(private svc: RecycleService) {}

  @Get()
  list() {
    return this.svc.list()
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
