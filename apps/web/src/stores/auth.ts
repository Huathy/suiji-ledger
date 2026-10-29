import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, getToken, setToken, OFFLINE } from '../api/client'

export const useAuthStore = defineStore('auth', () => {
  const hasUser = ref<boolean | null>(null)
  const ready = ref(false)

  async function bootstrap() {
    if (OFFLINE) {
      hasUser.value = true
      ready.value = true
      return
    }
    try {
      const r = await api<{ hasUser: boolean }>('/auth/bootstrap')
      hasUser.value = r.hasUser
    } catch {
      hasUser.value = null
    }
    ready.value = true
  }

  async function login(password: string) {
    if (OFFLINE) return
    const r = await api<{ token: string }>('/auth/login', { method: 'POST', body: { password } })
    setToken(r.token)
  }
  async function setup(password: string) {
    if (OFFLINE) return
    const r = await api<{ token: string }>('/auth/setup', { method: 'POST', body: { password } })
    setToken(r.token)
  }
  function logout() {
    if (OFFLINE) return
    setToken('')
  }
  const authed = () => OFFLINE || !!getToken()

  return { hasUser, ready, bootstrap, login, setup, logout, authed }
})
