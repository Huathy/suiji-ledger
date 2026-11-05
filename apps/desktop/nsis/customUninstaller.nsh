; SuijiLedger 自定义卸载确认（评审修复项 Q1：卸载前必须确认"是否清除本地用户数据"）
;
; electron-builder 在 uninstaller.nsh 的两处插桩：
;   · un.onInit 末尾（总在一键装 SetSilent 之后）→ !insertmacro customUnInit
;   · 卸载 section 文件删除前                     → !insertmacro customUnInstall
;
; ⚠️ 不能用 ${Silent} 判断是否交互：one-click GUI 卸载在 customUnInit 之前
; 已被模板 SetSilent silent（见 uninstaller.nsh un.onInit），此时 ${Silent} 恒真。
; 唯一可靠信号是命令行有没有 /S：控制面板/开始菜单卸载入口没有 /S；
; 自动更新与静默分发一律带 /S → 不弹框、保留数据。
;
; 行为：
;   [是]   连同本机数据一起清除（%APPDATA%\suiji-ledger-desktop：账本库/密钥/git 仓/备份）
;   [否]   只卸载程序，数据保留（默认项，重装自动找回）
;   [取消] 放弃卸载
; 选择记在寄存器 $9（"1"=清除），un.onInit 与卸载 section 之间共享。

!macro customUnInit
  StrCpy $9 "0"
  ClearErrors
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
    MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "卸载 SuijiLedger 前，是否连同本机记账数据一起清除？$\r$\n$\r$\n数据位置：%APPDATA%\suiji-ledger-desktop\data$\r$\n（账本数据库、加密密钥、Git 同步历史、自动备份）$\r$\n$\r$\n[是] 清除全部本地数据——不可恢复；没配 Git 同步的账本将永久丢失$\r$\n[否] 保留数据——重装后自动找回（推荐）$\r$\n[取消] 放弃卸载" /SD IDNO IDYES sujiAskDel IDCANCEL sujiAskQuit
    Goto sujiAskDone
    sujiAskDel:
      StrCpy $9 "1"
      Goto sujiAskDone
    sujiAskQuit:
      Quit
    sujiAskDone:
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} $9 == "1"
    ; electron 永远按"当前用户"存放数据；多用户安装模式下先切回 current
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    RMDir /r "$APPDATA\SuijiLedger" ; 历史目录名兜底（productName 时期遗留）
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
