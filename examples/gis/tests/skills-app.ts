/**
 * 技能文件 e2e 的 fixture 应用（M12）。
 *
 * app.skills() 缺省目录 'skills'（相对本文件 → tests/skills），里面放一个
 * greeting-guide 技能（SKILL.md frontmatter：name + description）。
 * 会话开始时模型收到技能目录摘要，按需调 skill 工具加载全文。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('skills-demo', { model: 'deepseek-v4-flash' })

app.agent('receptionist', {
  persona: '你是中医馆前台数字员工，按可用技能的规范行事。',
})

app.skills()

export default app
