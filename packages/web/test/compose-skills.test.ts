import { describe, expect, it } from 'vitest'
import { composeCordisYml } from '../src/compose.js'
import { defineApp } from '../src/index.js'

const baseOpts = {
  runtimeUrl: 'file:///runtime.js',
  appModuleUrl: 'file:///app.ts',
  outDir: '/tmp/.loom',
  port: 4620,
  apiPrefix: '/~loom',
}

describe('app.skills 声明器', () => {
  it('缺省目录是 skills；显式目录覆盖；重复声明拒绝', () => {
    const app = defineApp('x')
    app.skills()
    expect(app.spec.skills).toEqual({ dirs: ['skills'] })
    const app2 = defineApp('y')
    app2.skills({ dirs: ['knowledge', 'C:/abs/skills'] })
    expect(app2.spec.skills).toEqual({ dirs: ['knowledge', 'C:/abs/skills'] })
    expect(() => app.skills({ dirs: ['again'] })).toThrow(/重复/)
  })

  it('空目录数组 / 空字符串项拒绝', () => {
    const app = defineApp('x')
    expect(() => app.skills({ dirs: [] })).toThrow(/dirs/)
    expect(() => app.skills({ dirs: [''] })).toThrow(/dirs/)
  })
})

describe('composeCordisYml：技能三行', () => {
  it('无声明时无 skill 行（向后兼容）', () => {
    const yml = composeCordisYml(baseOpts)
    expect(yml).not.toContain('dsh-skill-filesystem')
    expect(yml).not.toContain('dsh-tool-skill')
  })

  it('声明时生成注册表 + 隔离模式文件提供方 + 模型面工具', () => {
    const yml = composeCordisYml({
      ...baseOpts,
      skillDirs: ['F:/deepseek/loom/examples/gis/skills', 'C:/abs/skills'],
    })
    expect(yml).toContain("- id: skill\n  name: '@deepseek-ai/dsh-skill'")
    expect(yml).toContain("- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'")
    expect(yml).toContain('includeDefaultRoots: false')
    expect(yml).toContain('- "F:/deepseek/loom/examples/gis/skills"')
    expect(yml).toContain('- "C:/abs/skills"')
    expect(yml).toContain("- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'")
  })
})
