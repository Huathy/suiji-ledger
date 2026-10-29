import { createRouter, createWebHashHistory } from 'vue-router'
import { getToken, OFFLINE } from './api/client'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue'), meta: { bare: true } },
    { path: '/', component: () => import('./views/HomeView.vue'), meta: { tab: true } },
    { path: '/trends', component: () => import('./views/TrendsView.vue'), meta: { tab: true } },
    { path: '/reconcile', component: () => import('./views/ReconcileView.vue'), meta: { tab: true } },
    { path: '/accounts', component: () => import('./views/AccountsView.vue'), meta: { tab: true } },
    { path: '/accounts/:id', component: () => import('./views/AccountDetailView.vue') },
    { path: '/month/:ym', component: () => import('./views/MonthDetailView.vue') },
    { path: '/types', component: () => import('./views/TypeManageView.vue') },
    { path: '/import', component: () => import('./views/ImportView.vue') },
    { path: '/loans', component: () => import('./views/LoansView.vue') },
    { path: '/recycle', component: () => import('./views/RecycleView.vue') },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    { path: '/sync', component: () => import('./views/SyncView.vue') },
    { path: '/me', component: () => import('./views/MeView.vue'), meta: { tab: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach((to) => {
  if (OFFLINE) return to.path === '/login' ? '/' : true // 离线模式无登录
  if (to.path !== '/login' && !getToken()) return '/login'
  if (to.path === '/login' && getToken()) return '/'
  return true
})
