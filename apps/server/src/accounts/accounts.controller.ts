import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { AccountsService } from './accounts.service'

@Controller('accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(private svc: AccountsService) {}

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

  @Post(':id/set-balance')
  setBalance(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setBalance(id, body)
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id)
  }
}
