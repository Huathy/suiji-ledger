import { Module } from '@nestjs/common'
import { SystemController } from './system.controller'
import { SystemService } from './system.service'
import { MonthsModule } from '../months/months.module'

@Module({
  imports: [MonthsModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
