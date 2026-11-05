import { Global, Module } from '@nestjs/common'
import { MonthsModule } from '../months/months.module'
import { SyncController } from './sync.controller'
import { SyncService } from './sync.service'
import { SyncConfigService } from './sync-config.service'
import { RecordMetaService } from './record-meta.service'
import { ProjectService } from './project.service'
import { ApplyRecordService } from './apply-record.service'

/**
 * 全局模块：`RecordMetaService` 要被 accounts / months / types / loans 的写路径共用，
 * 每个模块各 import 一次只会更乱，直接全局导出。
 */
@Global()
@Module({
  imports: [MonthsModule],
  controllers: [SyncController],
  providers: [RecordMetaService, SyncConfigService, ProjectService, ApplyRecordService, SyncService],
  exports: [RecordMetaService, SyncConfigService, ProjectService, ApplyRecordService, SyncService],
})
export class SyncModule {}
