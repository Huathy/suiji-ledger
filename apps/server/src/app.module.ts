import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { AuthModule } from './auth/auth.module'
import { AccountsModule } from './accounts/accounts.module'
import { TypesModule } from './types/types.module'
import { MonthsModule } from './months/months.module'
import { StatsModule } from './stats/stats.module'
import { SystemModule } from './system/system.module'
import { BackupService } from './backup.service'
import { RecycleModule } from './recycle/recycle.module'

@Global()
@Module({
  providers: [PrismaService, BackupService],
  exports: [PrismaService, BackupService],
  imports: [AuthModule, AccountsModule, TypesModule, MonthsModule, StatsModule, SystemModule, RecycleModule],
})
export class AppModule {}
