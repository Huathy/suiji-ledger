<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NavBar, Button, Field, RadioGroup, Radio, showSuccessToast } from 'vant'
import { api } from '../api/client'
import { parseQianjiFile, aggregateQianji, type QianjiParsed, type QianjiAggregated } from '../import/qianji'
import { money } from '../utils/money'
import { useGoBack } from '../utils/nav'

const router = useRouter()
const goBack = useGoBack()
const step = ref<'pick' | 'preview' | 'done'>('pick')
const parsing = ref(false)
const parseError = ref('')
const parsed = ref<QianjiParsed | null>(null)
const agg = ref<QianjiAggregated | null>(null)
const kinds = ref<Record<string, 'asset' | 'liability'>>({})
const openings = ref<Record<string, string>>({})
const committing = ref(false)
const result = ref<{ created: number; skipped: number; accountsCreated: string[] } | null>(null)

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!file) return
  parsing.value = true
  parseError.value = ''
  try {
    const p = await parseQianjiFile(file)
    if (p.bills.length === 0) {
      parseError.value = '没有解析到有效账单（' + p.skipped.map((s) => `${s.reason}×${s.count}`).join('，') + '）'
      parsing.value = false
      return
    }
    parsed.value = p
    agg.value = aggregateQianji(p.bills, {}, {})
    for (const a of agg.value.accounts) {
      kinds.value[a.name] = 'asset'
      openings.value[a.name] = '0'
    }
    step.value = 'preview'
  } catch (err: any) {
    parseError.value = err?.message || '解析失败'
  }
  parsing.value = false
}

/** 期初余额/账户性质修改后重算 */
function recompute() {
  if (!parsed.value) return
  const opening: Record<string, number> = {}
  for (const [k, v] of Object.entries(openings.value)) {
    const cents = Math.round(Number(v || '0') * 100)
    opening[k] = Number.isFinite(cents) ? cents : 0
  }
  agg.value = aggregateQianji(parsed.value.bills, opening, kinds.value)
}

async function commit() {
  if (!agg.value) return
  committing.value = true
  try {
    result.value = await api<{ created: number; skipped: number; accountsCreated: string[] }>('/import/snapshots', {
      method: 'POST',
      body: { snapshots: agg.value.payloads },
    })
    step.value = 'done'
    showSuccessToast(`导入 ${result.value.created} 条快照`)
  } finally {
    committing.value = false
  }
}

const conflictHint = computed(() => '已存在的月度记录（手动平账或之前导入）会保留，不会被覆盖')
</script>

<template>
  <div>
    <NavBar title="导入钱迹账单" left-arrow left-text="返回" @click-left="goBack('/')" />

    <!-- 步骤①：选择文件 -->
    <template v-if="step === 'pick'">
      <div class="card" style="text-align: center; padding: 28px 20px">
        <div style="font-size: 40px">🧾</div>
        <div style="font-size: 15px; font-weight: 600; margin: 10px 0 8px">导入钱迹账单 → 自动生成月度快照</div>
        <div style="font-size: 12px; color: var(--t3); line-height: 1.9">
          在钱迹 App：我的 → 导出数据 → 导出 Excel / CSV<br>
          上传后按账户逐月重放收支，补全你的净资产曲线<br>
          <b style="color: var(--brand)">推荐导出 Excel(.xlsx)</b>，CSV 若乱码请改用 xlsx
        </div>
        <label class="pick-btn">
          {{ parsing ? '解析中…' : '选择钱迹导出文件（.xlsx / .csv）' }}
          <input type="file" accept=".xlsx,.xls,.csv" style="display: none" @change="onFile" :disabled="parsing" />
        </label>
        <div v-if="parseError" style="font-size: 12px; color: var(--expense); margin-top: 12px">{{ parseError }}</div>
      </div>
      <div class="card" style="padding: 10px 14px">
        <div style="font-size: 11.5px; color: var(--t3); line-height: 2">
          说明：<br>
          · 仅生成<b>月度快照</b>（每月各账户余额），不保存逐笔明细<br>
          · 每月末余额 = 期初余额 + 该账户累计净流入（可在下一步填期初余额）<br>
          · 已报销/报销包聚合行自动跳过，防止重复计算<br>
          · 债类账单（借入/借出/收款/还款/利息）按近似规则映射
        </div>
      </div>
    </template>

    <!-- 步骤②：预览确认 -->
    <template v-if="step === 'preview' && agg">
      <div class="card">
        <div class="sec-t">解析结果</div>
        <div style="font-size: 13px" class="num">
          账单 <b>{{ parsed!.bills.length }}</b> 笔 ·
          账户 <b>{{ agg.accounts.length }}</b> 个 ·
          月份 <b>{{ agg.months[0] }}</b> ~ <b>{{ agg.months[agg.months.length - 1] }}</b> ·
          将生成快照 <b style="color: var(--brand)">{{ agg.snapshotCount }}</b> 条
        </div>
        <div v-for="s in parsed!.skipped" :key="s.reason" style="font-size: 10.5px; color: var(--t3); margin-top: 4px">
          跳过：{{ s.reason }} × {{ s.count }}
        </div>
        <div style="font-size: 10.5px; color: var(--warn); margin-top: 6px">{{ conflictHint }}</div>
      </div>

      <div class="card" v-for="a in agg.accounts" :key="a.name" style="margin-bottom: 10px">
        <div class="sec-t">🏦 {{ a.name }}</div>
        <div style="font-size: 11px; color: var(--t3)" class="num">
          活跃 {{ a.activeMonths }} 个月（{{ a.firstYm }} ~ {{ a.lastYm }}）· 净流入
          <span :class="a.netFlowCents >= 0 ? 'm-inc' : 'm-exp'">{{ money(a.netFlowCents, { signed: true }) }}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap">
          <RadioGroup v-model="kinds[a.name]" direction="horizontal" @change="recompute">
            <Radio name="asset" shape="dot">资产</Radio>
            <Radio name="liability" shape="dot">负债(欠款)</Radio>
          </RadioGroup>
          <Field v-model="openings[a.name]" type="digit" label="期初余额(元)" style="flex: 1; min-width: 180px; padding: 4px 8px" @update:model-value="recompute" />
        </div>
      </div>

      <div style="margin: 12px 16px 30px; display: flex; gap: 10px">
        <Button block round @click="step = 'pick'">重选文件</Button>
        <Button type="primary" block round :loading="committing" @click="commit">确认导入</Button>
      </div>
    </template>

    <!-- 步骤③：结果 -->
    <template v-if="step === 'done' && result">
      <div class="card" style="text-align: center; padding: 30px 20px">
        <div style="font-size: 44px">🎉</div>
        <div style="font-size: 16px; font-weight: 700; margin: 10px 0 6px">导入完成</div>
        <div style="font-size: 13px; color: var(--t2)" class="num">
          新建快照 <b>{{ result.created }}</b> 条 · 保留已有 <b>{{ result.skipped }}</b> 条<br>
          <template v-if="result.accountsCreated.length">新建账户：{{ result.accountsCreated.join('、') }}</template>
        </div>
        <Button type="primary" round block style="margin-top: 18px" @click="router.replace('/trends')">去看净资产走势</Button>
        <Button round block style="margin-top: 10px" @click="router.replace('/')">回总览</Button>
      </div>
    </template>
  </div>
</template>

<style>
.pick-btn {
  display: inline-block; margin-top: 18px; padding: 11px 22px;
  background: var(--brand); color: #fff; border-radius: 22px;
  font-size: 13.5px; font-weight: 600; cursor: pointer;
}
</style>
