import { Module } from '@nestjs/common'
import { AccountsController } from './accounts.controller'
import { AccountsService } from './accounts.service'
import { LoansController } from './loans.controller'
import { LoansService } from './loans.service'
import { MonthsModule } from '../months/months.module'

@Module({
  imports: [MonthsModule],
  controllers: [AccountsController, LoansController],
  providers: [AccountsService, LoansService],
  exports: [AccountsService],
})
export class AccountsModule {}
