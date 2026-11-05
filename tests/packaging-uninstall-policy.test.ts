/**
 * 打包脚本的**卸载策略一致性**（评审修复项 Std 8）。
 *
 * 卸载问答物理上必然是两份：便携包是 .bat（无 NSIS），安装版是 NSIS 宏（electron-builder 插桩）。
 * 两份实现用的是两套语言，靠"记得同步改另一边"维持一致——评审点名的正是这个风险：
 * 某天有人给 .bat 加了"清除前先搬走再删"的安全网，却没给 .nsh 加，
 * 于是安装版在文件占用时静默删库，而便携包会中止。
 *
 * 所以这里不追求"合成一份"（做不到，运行时不同），而是把**共同策略**钉成断言：
 *  ① 默认答案必须是"保留数据"（用户回车/直接关窗口都不能删库）；
 *  ② 清除路径必须先搬迁再删除，搬迁失败就中止（不许 `rd /s` 静默吞掉）；
 *  ③ 只有在明确选择"清除"之后才允许删数据目录。
 * 任何一侧偷偷改掉任意一条，这里就红。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

const portable = read('windows/assemble.py')
const nsis = read('apps/desktop/nsis/customUninstaller.nsh')

describe('卸载问答：便携包（uninstall.cmd）', () => {
  it('默认保留数据（回车=N 保留，不许默认删库）', () => {
    expect(portable).toContain('回车=N保留数据')
    expect(portable).toContain('if "%ANS%"=="" goto keepdata')
  })

  it('清除前先搬走，搬迁失败必须中止（不许吞错误继续 rd /s）', () => {
    const block = portable.slice(portable.indexOf(':dodata'), portable.indexOf(':keepdata'))
    expect(block).toContain('move "%DATAKEEP%" "%DATABAK%"')
    expect(block).toContain('if errorlevel 1')
    expect(block).toContain('exit /b 1')
  })

  it('数据目录删除只在"清除"分支里，保留分支逐项删程序文件', () => {
    const tail = portable.slice(portable.indexOf('rem 保留模式下只删程序文件不碰 data'))
    expect(tail).toContain('rd /s /q "%LOCALAPPDATA%\\SuijiLedger\\runtime"')
    // rd 不带 /s：目录非空时必失败，是最后一道数据安全网
    expect(tail).toContain('rd "%LOCALAPPDATA%\\SuijiLedger" >nul 2>&1')
  })
})

describe('卸载问答：安装版（NSIS 宏）', () => {
  it('三键问答且默认 IDNO（保留数据）', () => {
    expect(nsis).toContain('IDYES sujiAskDel IDCANCEL sujiAskQuit')
    expect(nsis).toContain('/SD IDNO')
  })

  it('静默卸载（/S）不弹框也不删数据', () => {
    // ${Silent} 不可靠（one-click 卸载会被模板提前置位），判据只能是命令行有没有 /S
    expect(nsis).toContain('${GetOptions} $R0 "/S" $R1')
    expect(nsis).toContain('${If} ${Errors}')
  })

  it('删除数据目录被 $9 == "1" 包住（只在"清除"分支生效）', () => {
    const macro = nsis.slice(nsis.indexOf('!macro customUnInstall'))
    expect(macro).toContain('${If} $9 == "1"')
    const guardIdx = macro.indexOf('${If} $9 == "1"')
    const rmIdx = macro.indexOf('RMDir /r "$APPDATA\\${APP_FILENAME}"')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(rmIdx).toBeGreaterThan(guardIdx)
  })
})

describe('便携包组装：不许硬编码本机 Node 路径（Std 8 附带项）', () => {
  it('node 路径只从 SUIJI_NODE / PATH 解析', () => {
    // 注释里提到旧路径不算违规，只有**当成路径字面量用**才算：raw 字符串或字符串里的绝对路径
    expect(portable).not.toMatch(/r'C:\\\\env/)
    expect(portable).not.toMatch(/["']C:\\\\env\\\\nodejs/)
    expect(portable).toContain("os.environ.get('SUIJI_NODE')")
    expect(portable).toContain('shutil.which(\'node\')')
  })

  it('两处用到 node 的地方都走 node_exe()（拷运行时 + 依赖闭包）', () => {
    expect(portable).toContain('cp(node_exe(), os.path.join(PACK, \'runtime\', \'node.exe\'))')
    expect(portable).toContain('node = node_exe()')
  })
})
