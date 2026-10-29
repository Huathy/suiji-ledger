import { Module } from '@nestjs/common'
import { StatsController } from './stats.controller'
import { StatsService } from './stats.service'
import { MonthsModule } from '../months/months.module'

@Module({
  imports: [MonthsModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
