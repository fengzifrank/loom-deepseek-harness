import re

p = 'examples/gis/tests/memory.e2e.test.ts'
t = open(p, encoding='utf8').read()
old = """    // 注入是同步投递（agent.inject → 下个 pre-step 消费并落日志）；轮询日志。
    const deadline = Date.now() + 20_000
    for (;;) {
      const log = sessionLogText(loom!.outDir, sessionId)
      if (log.includes('"kind":"runtime-context"') && log.includes('"form":"recall"')) break
      if (Date.now() > deadline) {
        throw new Error(`未在会话日志找到 loom-memory recall 注入；日志片段：${log.slice(0, 400)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const log = sessionLogText(loom!.outDir, sessionId)
    expect(log).toContain('万亩')
    expect(log).toContain('<loom-memory>')"""
new = """    // 注入证据走 events API（内存会话）：0.1.7 磁盘写入按批调度，无 key 快速失败
    // 路径的落盘时序不可依赖（Linux 批处理窗口 vs Windows write-through——CI 实测）；
    // /events 读的是同一事实源，与磁盘 flush 时序解耦。
    const events = await readEventRange(loom!.base, sessionId, -1, 1_000_000_000)
    const raw = JSON.stringify(events)
    expect(raw).toContain('"kind":"runtime-context"')
    expect(raw).toContain('"form":"recall"')
    expect(raw).toContain('万亩')
    expect(raw).toContain('<loom-memory>')"""
assert old in t, 'memory anchor missing'
t = t.replace(old, new, 1)
open(p, 'w', encoding='utf8', newline='\n').write(t)
print('memory keyless via events API')

p2 = 'examples/gis/tests/path-memory.e2e.test.ts'
t2 = open(p2, encoding='utf8').read()
old2 = """      const log = sessionLogText(loom!.outDir, sessionId)
      if (log.includes('"form":"recall"') && log.includes('待重验路径')) break
      if (Date.now() > deadline) {
        throw new Error(`未在会话日志找到待重验路径注入；片段：${log.slice(0, 400)}`)
      }"""
new2 = """      const log = sessionLogText(loom!.outDir, sessionId)
      if (log.includes('"form":"recall"') && log.includes('待重验路径')) break
      // 双通道证据：磁盘批处理窗口（CI/Linux）可能迟滞——events API（内存会话）
      // 是同一事实源的即时视图，任一通道命中即算注入成立。
      try {
        const probe = await readEventRange(loom!.base, sessionId, -1, 1_000_000_000)
        if (JSON.stringify(probe).includes('待重验路径')) break
      } catch { /* events 读取失败不阻断磁盘轮询 */ }
      if (Date.now() > deadline) {
        throw new Error(`未在会话日志找到待重验路径注入；片段：${log.slice(0, 400)}`)
      }"""
assert old2 in t2, 'path-memory anchor missing'
t2 = t2.replace(old2, new2, 1)
open(p2, 'w', encoding='utf8', newline='\n').write(t2)
print('path-memory dual-channel evidence')
