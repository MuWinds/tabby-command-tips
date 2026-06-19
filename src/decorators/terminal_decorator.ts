// 终端装饰器，监听终端输入并触发动态匹配、渲染下拉建议列表
import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService, Logger, LogService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'

import { MatchingService, MatchResult } from '../services/matching_service'
import { ScoringService } from '../services/scoring_service'
import { ShellDetectorService } from '../services/shell_detector_service'
import { HistoryService } from '../services/history_service'
import { LlmService } from '../services/llm_service'
import { CommandTipsConfig, DEFAULT_CONFIG, LlmContext } from '../models'

/** 终端装饰器，负责监听终端输入、触发动态匹配、渲染下拉建议列表 */
@Injectable()
export class CommandTipsTerminalDecorator extends TerminalDecorator {
  private readonly logger: Logger
  private subscriptions: Subscription[] = []
  private currentInput = ''
  private dropdownEl: HTMLElement | null = null
  private dropdownVisible = false
  private config: CommandTipsConfig = DEFAULT_CONFIG
  private currentProfileId = ''
  private currentShellType = 'bash'
  private matchDebounceTimer: any = null
  private selectedIndex = 0
  private currentSuggestions: MatchResult[] = []
  /** 当前激活的 tab（最后 attach 或 sessionChanged 的 tab）。 */
  private activeTab: BaseTerminalTabComponent | null = null
  /** 记录每个 tab 对应的 profileId，用于切换时恢复上下文。 */
  private tabProfiles = new Map<BaseTerminalTabComponent, string>()
  /** 记录每个 tab 对应的 shellType。 */
  private tabShellTypes = new Map<BaseTerminalTabComponent, string>()
  /** 标记列表 DOM 是否需要完整重建（结果集变化时置 true）。 */
  private listDirty = true
  /** 增量匹配缓存：上次匹配的输入和结果。 */
  private lastMatchInput = ''
  private lastMatchResults: MatchResult[] = []
  /** LLM 订阅和状态。 */
  private llmSubscription: Subscription | null = null
  private llmLoading = false
  private llmLoaded = false

  constructor (
    private readonly configService: ConfigService,
    private readonly matchingService: MatchingService,
    private readonly scoringService: ScoringService,
    private readonly shellDetector: ShellDetectorService,
    private readonly historyService: HistoryService,
    private readonly llmService: LlmService,
    private readonly log: LogService,
  ) {
    super()
    this.logger = log.create('command-tips')
    this.config = this.configService.store.commandTips || DEFAULT_CONFIG
    this.llmService.setConfig(this.config.llm)
    this.configService.changed$.subscribe(() => {
      this.config = this.configService.store.commandTips || DEFAULT_CONFIG
      this.llmService.setConfig(this.config.llm)
      this.scoringService.invalidateCache()
    })
    this.logger.info('Decorator constructed')
  }

  /** 将装饰器绑定到终端标签页，开始监听会话和输入事件 */
  attach (tab: BaseTerminalTabComponent): void {
    this.logger.info('attach() called')
    this.activeTab = tab

    // 监听 tab 获得焦点事件
    // - 跨 tab 切换：重置 currentInput，避免上一 tab 的输入残留串扰
    // - 同 tab 内窗口失焦再聚焦：保留 currentInput，否则用户输入到一半切走再回来下拉无法继续触发
    const focusedSub = tab.focused$.subscribe(() => {
      if (this.activeTab !== tab) {
        this.activeTab = tab
        this.hideDropdown()
        this.currentInput = ''
      }
    })
    this.subscriptions.push(focusedSub)

    const sessionSub = tab.sessionChanged$.subscribe(session => {
      if (!session) return
      this.logger.info('Session changed')
      this.onSessionChanged(tab, session)
    })
    this.subscriptions.push(sessionSub)

    const inputSub = tab.input$.subscribe(data => {
      this.onInput(tab, data)
    })
    this.subscriptions.push(inputSub)

    if (tab.session) {
      this.logger.info('Session already exists')
      this.onSessionChanged(tab, tab.session)
    }
  }

  /** 创建下拉列表的 DOM 结构（输入预览、列表容器、操作提示）并挂载到页面 */
  private createDropdown (): void {
    if (this.dropdownEl) return

    this.dropdownEl = document.createElement('div')
    this.dropdownEl.className = 'command-tips-dropdown'
    this.dropdownEl.style.cssText = `
      position: fixed;
      z-index: 10000;
      min-width: 300px;
      max-width: 600px;
      max-height: 340px;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      background: var(--theme-bg, #1e1e1e);
      border: 1px solid var(--theme-border, rgba(255,255,255,0.1));
      font-family: var(--theme-font, monospace);
      font-size: 13px;
      color: var(--theme-fg, #ccc);
      display: none;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
    `

    const header = document.createElement('div')
    header.style.cssText = 'padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03);'
    header.innerHTML = '<span style="color: rgba(255,255,255,0.5); font-style: italic;" class="ct-input-preview"></span>'
    this.dropdownEl.appendChild(header)

    const list = document.createElement('div')
    list.className = 'ct-list'
    list.style.cssText = 'max-height: 260px; overflow-y: auto; overflow-x: hidden;'
    this.dropdownEl.appendChild(list)

    const footer = document.createElement('div')
    footer.style.cssText = 'display: flex; gap: 12px; padding: 4px 10px; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); font-size: 11px; color: rgba(255,255,255,0.4);'
    footer.innerHTML = '<span>↑↓ 选择</span><span>→ 补全</span><span>Enter 确认</span><span>Esc 取消</span>'
    this.dropdownEl.appendChild(footer)

    document.body.appendChild(this.dropdownEl)

    document.addEventListener('keydown', this.onKeyDown, true)

    this.logger.info('Dropdown DOM created')
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.dropdownVisible) return

    // ESC 键：只要下拉列表显示就应响应
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.currentInput = ''
      this.hideDropdown()
      return
    }

    // 方向键和右方向键：需要有匹配结果才有意义
    if (this.currentSuggestions.length === 0) return

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault()
        event.stopPropagation()
        this.moveSelection(-1)
        break
      case 'ArrowDown':
        event.preventDefault()
        event.stopPropagation()
        this.moveSelection(1)
        break
      case 'ArrowRight':
        event.preventDefault()
        event.stopPropagation()
        this.confirmSelection()
        break
    }
  }

  private moveSelection (delta: number): void {
    this.selectedIndex = Math.max(0, Math.min(this.currentSuggestions.length - 1, this.selectedIndex + delta))
    this.updateSelection()
  }

  private confirmSelection (): void {
    if (this.currentSuggestions.length === 0) return
    const command = this.currentSuggestions[this.selectedIndex].entry.command
    this.injectCommand(this.activeTab?.session, command)
  }

  /** 完整渲染列表 DOM（仅在结果集变化时调用）。 */
  private renderFullList (): void {
    if (!this.dropdownEl) return
    const list = this.dropdownEl.querySelector('.ct-list') as HTMLElement
    if (!list) return

    list.innerHTML = ''
    for (let i = 0; i < this.currentSuggestions.length; i++) {
      const item = this.currentSuggestions[i]
      const el = document.createElement('div')
      el.className = 'ct-item'
      el.dataset.index = String(i)
      el.style.cssText = `
        padding: 5px 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        background: ${i === this.selectedIndex ? 'var(--theme-accent, #4a9eff)' : 'transparent'};
        color: ${i === this.selectedIndex ? 'var(--theme-bg, #1e1e1e)' : 'inherit'};
      `

      const badge = document.createElement('span')
      const badgeConfig = this.getBadgeConfig(item.matchType)
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: bold;
        flex-shrink: 0;
        background: ${badgeConfig.background};
        color: ${badgeConfig.color};
      `
      badge.textContent = badgeConfig.text
      el.appendChild(badge)

      // 如果是 LLM 结果，显示描述
      if (item.description && (item.matchType === 'llm-completion' || item.matchType === 'llm-suggestion')) {
        const desc = document.createElement('span')
        desc.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.4); flex-shrink: 0;'
        desc.textContent = item.description
        el.appendChild(desc)
      }

      const cmd = document.createElement('span')
      cmd.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis;'
      cmd.textContent = item.entry.command
      el.appendChild(cmd)

      if (this.config.showSourceTag) {
        const src = document.createElement('span')
        src.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.4); padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,0.05); flex-shrink: 0;'
        src.textContent = item.entry.source
        el.appendChild(src)
      }

      list.appendChild(el)
    }

    // 事件委托：mouseenter/click 统一在容器上处理
    list.onmouseenter = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('.ct-item') as HTMLElement
      if (!target) return
      const idx = parseInt(target.dataset.index || '-1', 10)
      if (idx >= 0 && idx !== this.selectedIndex) {
        this.selectedIndex = idx
        this.updateSelection()
      }
    }
    list.onclick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('.ct-item') as HTMLElement
      if (!target) return
      const idx = parseInt(target.dataset.index || '-1', 10)
      if (idx >= 0) {
        this.selectedIndex = idx
        this.confirmSelection()
      }
    }
  }

  /** 增量更新选中项样式（仅切换 CSS class，不重建 DOM）。 */
  private updateSelection (): void {
    if (!this.dropdownEl) return
    const list = this.dropdownEl.querySelector('.ct-list') as HTMLElement
    if (!list) return

    const items = list.children
    for (let i = 0; i < items.length; i++) {
      const el = items[i] as HTMLElement
      const isSelected = i === this.selectedIndex
      el.style.background = isSelected ? 'var(--theme-accent, #4a9eff)' : 'transparent'
      el.style.color = isSelected ? 'var(--theme-bg, #1e1e1e)' : 'inherit'
    }
  }

  /** 检测 Shell 类型，加载历史记录，并订阅终端输入事件 */
  private onSessionChanged (tab: BaseTerminalTabComponent, session: any): void {
    const env = session.environment || {}
    const processName = session.processName || ''
    const shellInfo = this.shellDetector.detect(env, processName)
    const shellType = shellInfo.type !== 'unknown' ? shellInfo.type : 'bash'
    const profileId = (tab as any).profile?.id || 'default'

    // 记录 tab 的上下文信息
    this.tabProfiles.set(tab, profileId)
    this.tabShellTypes.set(tab, shellType)

    this.activeTab = tab
    this.currentShellType = shellType
    this.currentProfileId = profileId
    this.logger.info(`Shell: ${shellType}, Profile: ${profileId}`)

    // 切换会话时隐藏旧下拉列表、重置输入状态
    this.hideDropdown()
    this.currentInput = ''

    this.loadShellHistory(shellInfo.historyFile)
  }

  /** 异步读取 Shell 历史文件并与 Tabby 历史合并，不阻塞主线程。 */
  private async loadShellHistory (historyFile: string | null): Promise<void> {
    if (!historyFile) return
    try {
      const fs = require('fs')
      const os = require('os')
      const expandedPath = historyFile.replace(/^~/, os.homedir())

      if (!fs.existsSync(expandedPath)) return

      const content = await fs.promises.readFile(expandedPath, 'utf-8')
      const shellEntries = this.historyService.parseHistoryContent(
        content, this.currentShellType, this.currentProfileId,
      )
      const tabbyEntries = this.historyService.getTabbyEntries(this.currentProfileId)
      const merged = this.historyService.mergeEntries(shellEntries, tabbyEntries)
      this.historyService.setTabbyEntries(this.currentProfileId, merged)
      this.logger.info(`Loaded ${merged.length} history entries`)
    } catch (err) {
      // 静默忽略
    }
  }

  /** 检查终端是否处于全屏程序模式（vim/nano/less 等使用 alternate screen buffer） */
  private isInFullscreenMode (tab: BaseTerminalTabComponent): boolean {
    try {
      const frontend = (tab as any).frontend
      if (!frontend) return false

      const buffer = frontend.xterm?.buffer?.active
      if (!buffer) return false

      // xterm.js 中，alternate screen buffer 的类型为 'alternate'
      // vim、nano、less、htop 等全屏程序会切换到这个缓冲区
      return buffer.type === 'alternate'
    } catch (err) {
      return false
    }
  }

  /** 逐字符解析终端输入，维护 currentInput 并触发匹配或记录命令 */
  private onInput (tab: BaseTerminalTabComponent, data: Buffer): void {
    // 只处理当前激活 tab 的输入
    if (tab !== this.activeTab) return

    // 如果当前在全屏程序（vim/nano/less 等）中，不处理输入
    if (this.isInFullscreenMode(tab)) {
      // 清空输入状态并隐藏下拉列表
      if (this.currentInput.length > 0) {
        this.currentInput = ''
        this.hideDropdown()
      }
      return
    }

    // 恢复该 tab 的上下文（可能被其他 tab 的 sessionChanged 覆盖）
    const savedProfile = this.tabProfiles.get(tab)
    const savedShell = this.tabShellTypes.get(tab)
    if (savedProfile) this.currentProfileId = savedProfile
    if (savedShell) this.currentShellType = savedShell

    const str = data.toString()

    // 转义序列状态机：遇到 \x1b 时跳过整个序列
    let inEscapeSequence = false

    for (const char of str) {
      if (char === '\x1b') {
        // ESC 字符，开始转义序列
        inEscapeSequence = true
        continue
      }

      if (inEscapeSequence) {
        // 转义序列以字母结束（CSI 序列格式：ESC [ <参数> <字母>）
        if (char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z') {
          inEscapeSequence = false
        }
        continue
      }

      if (char === '\r' || char === '\n') {
        this.syncInputFromOutput(tab)
        if (this.currentInput.trim()) {
          this.historyService.recordCommand(this.currentInput.trim(), this.currentProfileId, this.currentShellType)
        }
        this.currentInput = ''
        this.hideDropdown()
      } else if (char === '\x7f' || char === '\x08') {
        // 退格键：DEL (\x7f) 或 BS (\x08)
        this.currentInput = this.currentInput.slice(0, -1)
        this.handleInputChanged()
      } else if (char === '\x17') {
        // Ctrl+W：删除前一个单词
        const trimmed = this.currentInput.trimEnd()
        const lastSpace = trimmed.lastIndexOf(' ')
        this.currentInput = lastSpace >= 0 ? trimmed.substring(0, lastSpace + 1) : ''
        this.handleInputChanged()
      } else if (char === '\x15') {
        // Ctrl+U：删除整行
        this.currentInput = ''
        this.hideDropdown()
      } else if (char === '\x03') {
        // Ctrl+C：取消当前输入
        this.currentInput = ''
        this.hideDropdown()
      } else if (char === '\x01' || char === '\x05') {
        // Ctrl+A / Ctrl+E：光标移动，不修改输入，跳过
      } else if (char === '\x09') {
        // Tab 补全：shell 会在终端回显补全内容，延迟后从终端缓冲区同步
        setTimeout(() => {
          if (this.activeTab === tab) {
            this.syncInputFromOutput(tab)
            this.triggerMatch()
          }
        }, 100)
      } else if (char >= ' ') {
        this.currentInput += char
        this.triggerMatch()
      }
    }
  }

  /** 处理输入内容变化：检查是否需要隐藏下拉列表或触发匹配 */
  private handleInputChanged (): void {
    if (this.currentInput.length < this.config.minChars) {
      this.hideDropdown()
    } else {
      this.triggerMatch()
    }
  }

  // 从终端输出中同步实际的输入内容（处理 Tab 补全、Ctrl+C 后换行等场景）
  private syncInputFromOutput (tab: BaseTerminalTabComponent): void {
    try {
      const frontend = (tab as any).frontend
      if (!frontend) return

      const buffer = frontend.xterm?.buffer?.active
      if (!buffer) return

      const cursorLine = buffer.getLine(buffer.cursorY)
      if (!cursorLine) return

      const lineText = cursorLine.translateToString(true)
      if (!lineText || lineText.length === 0) return

      // 尝试匹配提示符后的内容
      const promptMatch = lineText.match(/[$%#>]\s*(.*)$/)
      if (promptMatch && promptMatch[1]) {
        const actualCommand = promptMatch[1].trim()
        // 仅当成功提取到非空内容时才更新 currentInput，
        // 否则保留逐字符累积的结果，避免因终端缓冲区未及时更新而误清空
        if (actualCommand) {
          this.currentInput = actualCommand
        }
      }
    } catch (err) {
      // 静默忽略，回退到 currentInput
    }
  }

  private triggerMatch (): void {
    if (this.matchDebounceTimer) {
      clearTimeout(this.matchDebounceTimer)
    }
    this.matchDebounceTimer = setTimeout(() => {
      this.executeMatch()
    }, this.config.debounceMs)
  }

  /** 执行匹配流程：获取历史、匹配、排序后显示下拉列表。支持增量匹配缓存和 LLM 增强。 */
  private executeMatch (): void {
    if (!this.config.enabled) return

    if (this.currentInput.length < this.config.minChars) {
      this.hideDropdown()
      return
    }

    this.createDropdown()

    // 取消之前的 LLM 订阅
    if (this.llmSubscription) {
      this.llmSubscription.unsubscribe()
      this.llmSubscription = null
    }
    this.llmLoading = false
    this.llmLoaded = false

    // 构建 LLM 上下文
    const llmContext: LlmContext = {
      currentDirectory: this.getCurrentDirectory(),
      recentCommands: this.getRecentCommands(),
      shellType: this.currentShellType,
      currentUser: this.getCurrentUser(),
    }

    // 增量匹配：当新输入是旧输入的前缀扩展时，复用旧结果
    let matchResults: MatchResult[]
    if (this.lastMatchResults.length > 0 &&
        this.currentInput.startsWith(this.lastMatchInput) &&
        this.lastMatchInput.length >= this.config.minChars) {
      const lower = this.currentInput.toLowerCase()
      matchResults = this.lastMatchResults.filter(r =>
        r.entry.command.toLowerCase().startsWith(lower) ||
        this.matchingService.isSubsequence(lower, r.entry.command.toLowerCase()),
      )
    } else {
      const allEntries = this.historyService.getTabbyEntries(this.currentProfileId)
      matchResults = this.matchingService.execute(this.currentInput, allEntries, this.config.matching)
    }

    // 更新缓存
    this.lastMatchInput = this.currentInput
    this.lastMatchResults = matchResults

    // 如果 LLM 启用，使用 executeWithLlm 获取异步结果
    if (this.config.llm.enabled && this.llmService.isAvailable()) {
      this.llmLoading = true
      this.updateLlmStatusIndicator()

      const allEntries = this.historyService.getTabbyEntries(this.currentProfileId)
      this.llmSubscription = this.matchingService.executeWithLlm(
        this.currentInput,
        allEntries,
        this.config.matching,
        llmContext,
      ).subscribe({
        next: (results) => {
          this.currentSuggestions = this.scoringService.sortWithLimit(
            results,
            this.config.scoring,
            this.config.maxResults,
          )
          this.selectedIndex = 0
          this.listDirty = true
          this.showDropdown()
        },
        error: (err) => {
          this.logger.warn('LLM matching error:', err)
          this.llmLoading = false
          this.llmLoaded = true
          this.updateLlmStatusIndicator()
        },
        complete: () => {
          this.llmLoading = false
          this.llmLoaded = true
          this.updateLlmStatusIndicator()
        },
      })
    } else {
      // LLM 未启用，直接显示历史记录结果
      if (matchResults.length === 0) {
        this.hideDropdown()
        return
      }

      const sortedResults = this.scoringService.sortWithLimit(
        matchResults,
        this.config.scoring,
        this.config.maxResults,
      )

      this.currentSuggestions = sortedResults
      this.selectedIndex = 0
      this.listDirty = true
      this.showDropdown()
    }
  }

  /** 获取当前工作目录。 */
  private getCurrentDirectory (): string {
    try {
      const session = this.activeTab?.session as any
      if (session?.cwd) return session.cwd
      if (session?.environment?.PWD) return session.environment.PWD
    } catch (err) {
      // 静默忽略
    }
    return '~'
  }

  /** 获取最近的命令历史。 */
  private getRecentCommands (): string[] {
    const entries = this.historyService.getTabbyEntries(this.currentProfileId)
    return entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10)
      .map(e => e.command)
  }

  /** 获取当前用户名。 */
  private getCurrentUser (): string {
    try {
      const session = this.activeTab?.session as any
      if (session?.environment?.USER) return session.environment.USER
      if (session?.environment?.USERNAME) return session.environment.USERNAME
    } catch (err) {
      // 静默忽略
    }
    return 'user'
  }

  private showDropdown (): void {
    if (!this.dropdownEl) return

    const preview = this.dropdownEl.querySelector('.ct-input-preview')
    if (preview) preview.textContent = this.currentInput

    if (this.listDirty) {
      this.renderFullList()
      this.listDirty = false
    }

    this.dropdownEl.style.display = 'block'
    this.dropdownVisible = true
  }

  private hideDropdown (): void {
    if (!this.dropdownEl) return
    this.dropdownEl.style.display = 'none'
    this.dropdownVisible = false
    this.currentSuggestions = []
    this.lastMatchInput = ''
    this.lastMatchResults = []

    // 清理 LLM 订阅
    if (this.llmSubscription) {
      this.llmSubscription.unsubscribe()
      this.llmSubscription = null
    }
    this.llmLoading = false
    this.llmLoaded = false
  }

  /** 将选中的命令注入终端：批量删除当前输入，再写入新命令 */
  private injectCommand (session: any, command: string): void {
    if (!session) return
    // 批量发送退格符，一次 write 调用
    if (this.currentInput.length > 0) {
      session.write(Buffer.from('\x7f'.repeat(this.currentInput.length)))
    }
    session.write(Buffer.from(command))
    this.currentInput = command
    this.hideDropdown()
  }

  /** 解除装饰器绑定，清理所有订阅、定时器和 DOM 元素 */
  detach (tab: BaseTerminalTabComponent): void {
    this.tabProfiles.delete(tab)
    this.tabShellTypes.delete(tab)

    // 只清理该 tab 相关的订阅
    // 由于 subscriptions 数组中混合了 sessionSub 和 inputSub，
    // 全部清理安全——detach 通常在 tab 关闭时调用
    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions = []

    // 清理 LLM 订阅
    if (this.llmSubscription) {
      this.llmSubscription.unsubscribe()
      this.llmSubscription = null
    }

    if (this.activeTab === tab) {
      this.activeTab = null
      this.hideDropdown()
      this.currentInput = ''
    }

    if (this.matchDebounceTimer) {
      clearTimeout(this.matchDebounceTimer)
    }
    if (this.dropdownEl) {
      this.dropdownEl.remove()
      this.dropdownEl = null
    }
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.historyService.dispose()
  }

  /** 根据匹配类型返回标签配置。 */
  private getBadgeConfig (matchType: string): { text: string; background: string; color: string } {
    switch (matchType) {
      case 'prefix':
        return { text: 'P', background: 'rgba(76,175,80,0.3)', color: '#4caf50' }
      case 'fuzzy':
        return { text: 'F', background: 'rgba(255,193,7,0.3)', color: '#ffc107' }
      case 'llm-completion':
        return { text: 'C', background: 'rgba(33,150,243,0.3)', color: '#2196f3' }
      case 'llm-suggestion':
        return { text: 'S', background: 'rgba(156,39,176,0.3)', color: '#9c27b0' }
      default:
        return { text: '?', background: 'rgba(158,158,158,0.3)', color: '#9e9e9e' }
    }
  }

  /** 更新 LLM 状态指示器。 */
  private updateLlmStatusIndicator (): void {
    if (!this.dropdownEl) return
    let statusEl = this.dropdownEl.querySelector('.ct-llm-status') as HTMLElement
    if (!statusEl) {
      statusEl = document.createElement('div')
      statusEl.className = 'ct-llm-status'
      statusEl.style.cssText = 'padding: 3px 10px; font-size: 10px; color: rgba(255,255,255,0.4); border-top: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.02);'
      this.dropdownEl.appendChild(statusEl)
    }

    if (this.llmLoading) {
      statusEl.textContent = '⏳ AI 加载中...'
      statusEl.style.display = 'block'
    } else if (this.llmLoaded) {
      statusEl.textContent = '✓ AI 已加载'
      statusEl.style.display = 'block'
    } else {
      statusEl.style.display = 'none'
    }
  }
}
