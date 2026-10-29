<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NavBar, Popup, Field, CellGroup, Button, RadioGroup, Radio, showSuccessToast, showConfirmDialog } from 'vant'
import { api } from '../api/client'
import { directionLabel, type Direction } from '../../../../packages/shared/src/index'
import { useGoBack } from '../utils/nav'

interface TypeInfo { id: number; name: string; emoji: string; direction: Direction; builtin: boolean; usageCount: number; color: string | null }

const goBack = useGoBack()
const types = ref<TypeInfo[]>([])
const sheetShow = ref(false)
const editId = ref<number | null>(null)
const form = ref({ name: '', emoji: '💼', direction: 'income' as Direction, color: '' })
const emojiQuick = ['💼', '📈', '🏠', '🚗', '🏥', '🎓', '🎁', '🛫', '📱', '💰']
const colorQuick = ['', '#3b82f6', '#00b578', '#f04848', '#ff8800', '#7b61ff', '#22d3ee', '#f472b6']

/** 正在编辑内置类型：只允许改图标与颜色，名称/方向锁定 */
const isBuiltinEdit = computed(() => !!types.value.find((t) => t.id === editId.value)?.builtin)

async function load() {
  types.value = await api<TypeInfo[]>('/types')
}
onMounted(load)

function openAdd() {
  editId.value = null
  form.value = { name: '', emoji: '💼', direction: 'income', color: '' }
  sheetShow.value = true
}
function openEdit(t: TypeInfo) {
  editId.value = t.id
  form.value = { name: t.name, emoji: t.emoji, direction: t.direction, color: t.color || '' }
  sheetShow.value = true
}
async function save() {
  if (editId.value === null) {
    await api('/types', { method: 'POST', body: form.value })
  } else if (isBuiltinEdit.value) {
    await api('/types/' + editId.value, { method: 'PATCH', body: { emoji: form.value.emoji, color: form.value.color || null } })
  } else {
    await api('/types/' + editId.value, { method: 'PATCH', body: form.value })
  }
  showSuccessToast('已保存')
  sheetShow.value = false
  await load()
}
async function remove(t: TypeInfo) {
  await showConfirmDialog({
    title: `删除「${t.name}」？`,
    message: '该类型下的历史条目会自动回退为「⚖️ 平账」，数据不会丢失。',
  })
  await api('/types/' + t.id, { method: 'DELETE' })
  showSuccessToast('已删除')
  await load()
}
</script>

<template>
  <div>
    <NavBar title="类型管理" left-arrow left-text="返回" @click-left="goBack('/')">
      <template #right><button class="nav-act" @click="openAdd">＋ 新建</button></template>
    </NavBar>

    <div class="card" style="padding: 4px 14px">
      <div v-for="t in types.filter((x) => x.builtin)" :key="t.id" class="row-line" style="cursor: pointer" @click="openEdit(t)">
        <span class="cicon" :style="t.color ? { boxShadow: 'inset 0 0 0 2px ' + t.color } : {}">{{ t.emoji }}</span>
        <div style="flex: 1">
          <div style="font-size: 13.5px; font-weight: 500">{{ t.name }} <span class="builtin-badge">内置 · 不可删</span></div>
          <div style="font-size: 10.5px; color: var(--t3)">未解释的余额变动自动归入此类型 · 可改图标与颜色</div>
        </div>
        <span style="font-size: 11px; color: var(--t3)">使用 {{ t.usageCount }} 次</span>
      </div>
    </div>

    <div class="grp-label">自定义类型（给月报归因用的标签）</div>
    <div class="card" style="padding: 4px 14px" v-if="types.some((t) => !t.builtin)">
      <div v-for="t in types.filter((x) => !x.builtin)" :key="t.id" class="row-line" style="cursor: pointer" @click="openEdit(t)">
        <span class="cicon" :style="t.color ? { boxShadow: 'inset 0 0 0 2px ' + t.color } : {}">{{ t.emoji }}</span>
        <div style="flex: 1">
          <div style="font-size: 13.5px; font-weight: 500">{{ t.name }}</div>
          <div style="font-size: 10.5px; color: var(--t3)">{{ directionLabel[t.direction] }}方向 · 使用 {{ t.usageCount }} 次</div>
        </div>
        <button class="link-btn danger" @click.stop="remove(t)">删</button>
      </div>
    </div>
    <div v-else class="empty-tip">还没有自定义类型<br>常用如：💼 工资（收入）/ 🏠 房贷（支出）/ 📈 投资（收入）</div>

    <div style="margin: 14px 16px">
      <Button block round plain type="primary" @click="openAdd">＋ 新建类型（emoji · 名称 · 方向）</Button>
    </div>

    <Popup v-model:show="sheetShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 12px">{{ editId ? (isBuiltinEdit ? '编辑内置类型（仅图标与颜色）' : '编辑类型') : '新建类型' }}</div>
      <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px">
        <button v-for="e in emojiQuick" :key="e" type="button" class="emoji-chip" :class="{ on: form.emoji === e }" @click="form.emoji = e">{{ e }}</button>
      </div>
      <CellGroup inset>
        <Field v-model="form.emoji" label="图标" maxlength="4" />
        <Field v-if="!isBuiltinEdit" v-model="form.name" label="名称" maxlength="12" placeholder="如：工资 / 房贷 / 投资" />
        <Field v-if="!isBuiltinEdit" label="收支方向">
          <template #input>
            <RadioGroup v-model="form.direction" direction="horizontal">
              <Radio name="income">收入</Radio>
              <Radio name="expense">支出</Radio>
              <Radio name="neutral">中性</Radio>
            </RadioGroup>
          </template>
        </Field>
      </CellGroup>
      <div class="grp-label" style="padding-left: 0">标记色（可选）</div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap">
        <button v-for="c in colorQuick" :key="c || 'none'" type="button" class="color-dot" :class="{ on: form.color === c }"
          :style="c ? { background: c } : {}" :aria-label="c ? '使用颜色 ' + c : '不使用颜色'" @click="form.color = c">
          <span v-if="!c" style="font-size: 10px">无</span>
        </button>
      </div>
      <div style="font-size: 10.5px; color: var(--t3); margin-top: 10px">
        方向用于区间统计识别「大项收入」：工资/投资选收入，房贷/学费选支出。
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="sheetShow = false">取消</Button>
        <Button type="primary" block round :disabled="!isBuiltinEdit && !form.name.trim()" @click="save">保存</Button>
      </div>
    </Popup>
  </div>
</template>

<style>
.grp-label { font-size: 11.5px; color: var(--t3); padding: 12px 18px 2px; }
.builtin-badge { font-size: 9px; color: var(--brand); background: var(--focus-bg); border-radius: 5px; padding: 1px 6px; font-weight: 400; }
.emoji-chip { font-size: 16px; padding: 6px 10px; border-radius: 9px; background: var(--cell); cursor: pointer; border: none; min-height: 34px; }
.emoji-chip.on { outline: 2px solid var(--brand); }
.color-dot { width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid var(--line); cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--t3); padding: 0; background: var(--cell); }
.color-dot.on { outline: 2px solid var(--brand); outline-offset: 2px; }
.nav-act { border: none; background: transparent; color: var(--brand); font-size: 13px; cursor: pointer; font-family: inherit; min-height: 40px; padding: 8px 6px; }
.link-btn {
  border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--brand); padding: 6px 8px; min-width: 40px; min-height: 36px;
  border-radius: 8px; flex-shrink: 0;
}
.link-btn:hover { background: var(--cell); }
.link-btn.danger { color: var(--expense); }
</style>
