import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { TypesService } from './types.service'

@Controller('types')
@UseGuards(AuthGuard)
export class TypesController {
  constructor(private svc: TypesService) {}

  @Get()
  list() {
    return this.svc.list()
  }

  @Post()
  create(@Body() body: any) {
    return this.svc.create(body)
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.update(id, body)
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id)
  }
}
