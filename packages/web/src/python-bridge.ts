/**
 * 薄 re-export（M8 插件化）：Python 工具桥已抽出为独立 workspace 成员
 * `dsh-python-tools`（packages/python-tools；包名/API 形状不变，cordis 插件
 * named exports name/inject/apply/Config 原样）。本模块仅为 @loom-sdk/web 的
 * 既有导入方（index.ts 公共出口、compose 的 file:/// URL 兼容）保留。
 * @module @loom-sdk/web/python-bridge
 */
export {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  RESTART_INTERVAL_MS,
  DEFAULT_RESTART_LIMIT,
  DEFAULT_CALL_TIMEOUT_MS,
  LOOM_PYTHON_SERVICE,
  parsePythonCommand,
  encodeFrame,
  createLineDecoder,
  validateInitializeResult,
  validatePythonManifest,
  pythonEntryToToolDef,
  normalizePythonDsl,
  proxyToolArgs,
  PythonBridge,
  name,
  inject,
  Config,
  apply,
} from 'dsh-python-tools'
export type {
  PythonToolEntry,
  ProxyToolDefinition,
  PythonToolForwarder,
  BridgeLogger,
  PythonBridgeOptions,
  PythonBridgeStatus,
  PythonBridgeConfig,
  LoomPythonService,
  ToolInputDSL as PythonToolInputDSL,
  ToolOutputDSL as PythonToolOutputDSL,
} from 'dsh-python-tools'
