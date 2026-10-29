import { Module } from '@nestjs/common'
import { RecycleController } from './recycle.controller'
import { RecycleService } from './recycle.service'
import { MonthsModule } from '../months/months.module'

@Module({
  imports: [MonthsModule],
  controllers: [RecycleController],
  providers: [RecycleService],
})
export class RecycleModule {}
