import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { LoansService } from './loans.service'

@Controller('loans')
@UseGuards(AuthGuard)
export class LoansController {
  constructor(private svc: LoansService) {}

  @Get()
  list() {
    return this.svc.list()
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
