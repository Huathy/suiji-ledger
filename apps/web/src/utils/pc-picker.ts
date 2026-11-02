/**
 * PC 端选择器支持（问题 1）：Vant Picker / DatePicker 的列只绑定了 touch 事件
 * （vant/lib/picker/PickerColumn.js 里只有 onTouchStart / onTouchMove / onTouchEnd），
 * 所以桌面端「滚轮不动、按住拖动也没反应」。
 *
 * 解法：在 document 上做事件委托，把鼠标行为翻译成 Vant 原生支持的「点击选项」——
 * 每个选项 li 都挂了 onClick → onClickOption(index)，会带动画地切换选中值并 emit change
 * （无 touch 时内部 moving 恒为 false，值会立即生效），
 * 因此不必侵入组件内部，也不与移动端 touch 逻辑冲突。业务页面零改动。
 *
 * - wheel：以当前选中项为锚，滚一格换一项；触控板小步滚动做累计，避免一次跳很多
 * - 鼠标拖动：按位移换算格数，实时点选目标项，跟手
 * 对 .van-picker-column 的所有列生效（含 DatePicker 的年/月/日多列与级联列）。
 */

const COLUMN_SEL = '.van-picker-column'
const ITEM_SEL = '.van-picker-column__item'
const SELECTED_CLASS = 'van-picker-column__item--selected'
const DISABLED_CLASS = 'van-picker-column__item--disabled'
/** 滚轮累计阈值（px）：超过才换一格 */
const WHEEL_STEP = 50

function itemsOf(col: HTMLElement): HTMLElement[] {
  return Array.from(col.querySelectorAll<HTMLElement>(ITEM_SEL))
}

function selectedIndexOf(items: HTMLElement[]): number {
  return items.findIndex((li) => li.classList.contains(SELECTED_CLASS))
}

/**
 * 点选第 idx 项：越界夹住，禁用项就近换成可用项。
 * 每次都重新查询 li —— 级联列（如 DatePicker 换月后日列重建）会替换 DOM 节点。
 */
function pick(col: HTMLElement, idx: number) {
  const items = itemsOf(col)
  if (!items.length) return
  const disabled = (i: number) => i < 0 || i >= items.length || items[i].classList.contains(DISABLED_CLASS)
  let target = Math.max(0, Math.min(items.length - 1, idx))
  if (disabled(target)) {
    let up = target, down = target
    while (up < items.length && disabled(up)) up++
    while (down >= 0 && disabled(down)) down--
    if (up >= items.length && down < 0) return
    if (up >= items.length) target = down
    else if (down < 0) target = up
    else target = up - target <= target - down ? up : down
  }
  items[target].click()
}

/** 取事件所属的「可见」picker 列（弹窗关闭 / 隐藏时不响应） */
function columnOf(e: Event): HTMLElement | null {
  const el = (e.target as HTMLElement | null)?.closest?.(COLUMN_SEL) as HTMLElement | null
  if (!el || !el.getClientRects().length) return null
  return el
}

function optionHeight(col: HTMLElement): number {
  const li = col.querySelector<HTMLElement>(ITEM_SEL)
  return li && li.offsetHeight ? li.offsetHeight : 44
}

let installed = false

export function installPcPickerSupport() {
  if (installed || typeof document === 'undefined') return
  // 仅精确指针（鼠标/触控板）设备启用：移动端 Vant 原生 touch 已可用，
  // 这里再拦 mousedown 的默认行为反而可能干扰 WebView 的点击/滚动。
  if (!window.matchMedia?.('(pointer: fine)').matches) return
  installed = true

  // ---------- 滚轮 ----------
  let acc = 0
  let resetTimer: ReturnType<typeof setTimeout> | undefined
  document.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      const col = columnOf(e)
      if (!col) return
      e.preventDefault() // 别让弹窗背后的页面跟着滚
      const cur = selectedIndexOf(itemsOf(col))
      if (cur < 0) return
      acc += e.deltaY
      if (Math.abs(acc) < WHEEL_STEP) {
        clearTimeout(resetTimer)
        resetTimer = setTimeout(() => (acc = 0), 180)
        return
      }
      const step = acc > 0 ? 1 : -1
      acc = 0
      clearTimeout(resetTimer)
      pick(col, cur + step)
    },
    { passive: false },
  )

  // ---------- 鼠标拖动 ----------
  document.addEventListener('mousedown', (e: MouseEvent) => {
    const col = columnOf(e)
    if (!col || e.button !== 0) return
    const startIdx = selectedIndexOf(itemsOf(col))
    if (startIdx < 0) return
    e.preventDefault() // 避免拖动时把整段文字选中（preventDefault 不阻止 click，Vant 点选仍可用）
    const h = optionHeight(col)
    const startY = e.clientY
    let lastIdx = startIdx
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'

    const onMove = (ev: MouseEvent) => {
      // 向下拖 → 内容跟着下移，露出更早的选项（索引变小）
      const total = itemsOf(col).length
      const idx = Math.max(0, Math.min(total - 1, startIdx - Math.round((ev.clientY - startY) / h)))
      if (idx !== lastIdx) {
        lastIdx = idx
        pick(col, idx)
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}
