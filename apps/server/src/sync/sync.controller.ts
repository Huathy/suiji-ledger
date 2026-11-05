import { Body, Controller, Delete, Get, Post, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { SyncService } from './sync.service'

/**
 * 同步端点（§8.1）。注意全站有 `api` 前缀 → 实际路径是 `/api/system/sync/*`。
 * 裁决端点只有一套语义：`{ items:[{key, pick, fieldPicks?}], push? }`，
 * v1.1 的 `{strategy, picks}` 已废弃（两套写法前端必然写错一个）。
 */
@Controller('system/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private svc: SyncService) {}

  @Get('status')
  status() {
    return this.svc.status()
  }

  /**
   * 手动触发同步。`?phase=push|pull` 限定单程；`?force=lease` 走 D9/§6.3 租约式强推
   * （前端必须先弹二次确认——远端若不是我们上次推到的那一版会被拒绝并转人工）。
   * 注意：phase 走 query（doc23:68 误写 body，以代码为准并回写文档）。
   *
   * 这个入口是**用户点击**：`userInitiated=true` 同时作为「解除 halted、重试预算重新起算」的唯一信号。
   */
  @Post('run')
  run(@Query('phase') phase?: string, @Query('force') force?: string) {
    return this.svc.run({
      phase: phase === 'push' || phase === 'pull' ? phase : undefined,
      forceLease: force === 'lease',
      userInitiated: true,
    })
  }

  @Get('conflicts')
  conflicts() {
    return this.svc.conflicts()
  }

  @Post('resolve')
  resolve(@Body() body: any) {
    return this.svc.resolve(body?.items || [], body?.push !== false)
  }

  @Delete('conflict')
  abort() {
    return this.svc.abortConflict()
  }

  @Get('history')
  history(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.svc.history(Number(limit) || 50, Number(cursor) || 0)
  }

  @Get('diff')
  diff(@Query('oid') oid?: string) {
    return this.svc.diff(String(oid || ''))
  }

  @Post('restore')
  restore(@Body() body: any) {
    return this.svc.restore(String(body?.oid || ''), body?.mode === 'apply' ? 'apply' : 'preview')
  }
}
