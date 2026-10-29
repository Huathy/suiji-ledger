<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Field, CellGroup, Button, showToast } from 'vant'
import { useAuthStore } from '../stores/auth'
import { getServerBase, setServerBase } from '../api/client'

const auth = useAuthStore()
const router = useRouter()
const mode = ref<'check' | 'setup' | 'login'>('check')
const pwd = ref('')
const pwd2 = ref('')
const loading = ref(false)
// 服务器地址：APK 内预填内置默认；Web 同源部署留空即可
const server = ref(getServerBase())
const serverTouched = ref(false)

onMounted(async () => {
  await auth.bootstrap()
  mode.value = auth.hasUser ? 'login' : 'setup'
})

async function submit() {
  if (serverTouched.value) setServerBase(server.value)
  if (mode.value === 'setup') {
    if (pwd.value.length < 6) return showToast('口令至少 6 位')
    if (pwd.value !== pwd2.value) return showToast('两次输入不一致')
    loading.value = true
    try {
      await auth.setup(pwd.value)
      router.replace('/')
    } finally { loading.value = false }
  } else {
    loading.value = true
    try {
      await auth.login(pwd.value)
      router.replace('/')
    } finally { loading.value = false }
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-inner">
      <div class="login-logo">⚖️</div>
      <div class="login-title">SuijiLedger</div>
      <div class="login-sub">每月记一次余额 · 自动平账 · 看清资产负债</div>
      <CellGroup inset style="margin-top: 28px">
        <Field v-model="pwd" type="password" label="口令" placeholder="访问口令" @keyup.enter="submit" />
        <Field v-if="mode === 'setup'" v-model="pwd2" type="password" label="确认" placeholder="再输入一次" @keyup.enter="submit" />
        <Field v-model="server" label="服务器" placeholder="留空 = 本机同源部署"
          @update:model-value="serverTouched = true" right-icon="setting-o" />
      </CellGroup>
      <div class="login-note">
        App 使用时填电脑地址，如 http://192.168.10.5:3000；浏览器访问同机部署可留空。
      </div>
      <div style="margin: 20px 0">
        <Button type="primary" round block :loading="loading" @click="submit">
          {{ mode === 'setup' ? '设置口令并开始' : '进入' }}
        </Button>
      </div>
      <div class="empty-tip" style="padding-top: 8px">
        数据 100% 自托管 · 无账号体系 · 单一口令即全部
      </div>
    </div>
  </div>
</template>

<style>
.login-wrap { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; padding-bottom: 10vh; }
/* PC 上不再把输入框/按钮拉成 1352px 全宽（走查 S3） */
.login-inner { width: 100%; max-width: 420px; padding: 0 4px; }
.login-logo { font-size: 54px; text-align: center; }
.login-title { font-size: 22px; font-weight: 700; text-align: center; margin-top: 10px; color: var(--t1); }
.login-sub { font-size: 12px; text-align: center; color: var(--t3); margin-top: 6px; }
.login-note { font-size: 10.5px; color: var(--t3); margin: 8px 24px 0; line-height: 1.7; }
</style>
