/**
 * HTTP 路由规则治理：`.http()` 工具 → 服务器根绝对路径的**唯一**推导处。
 *
 * 规则：自定义 path 原样（服务器根绝对，如 '/~loom/special/path'）；缺省
 * `${apiPrefix}/api/<toolName>`。runtime 注册、health 清单、client 生成器、
 * openapi 生成器四处调用点共用本函数——改路由规则只改这里。
 * @module @loom-sdk/web/http-route
 */

import type { ToolSpec } from './types.js'

/** httpRouteOf 需要的最小工具形状（浅依赖，便于合成 app 测试复用）。 */
export type HttpRouteTool = Pick<ToolSpec, 'name'> & { readonly http?: { readonly method: string; readonly path?: string } }

/**
 * 工具的完整 HTTP 路由（服务器根绝对路径）。
 * @param tool - 声明了 `.http()` 的工具（path 未声明时走缺省规则）。
 * @param apiPrefix - 应用 API 前缀（如 '/~loom'；尾斜杠容忍）。
 */
export function httpRouteOf(tool: HttpRouteTool, apiPrefix: string): string {
  const custom = tool.http?.path
  if (custom !== undefined) return custom
  const prefix = apiPrefix.replace(/\/+$/, '') || '/~loom'
  return `${prefix}/api/${tool.name}`
}
