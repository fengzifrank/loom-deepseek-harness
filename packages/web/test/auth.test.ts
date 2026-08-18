/**
 * M7 单测：身份纯函数 —— token 签发/验签/过期/篡改、scrypt 哈希、
 * resolveIdentity 优先级、AccountStore 注册/登录（临时目录落盘）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AccountStore,
  hashPassword,
  newAnonUserId,
  resolveIdentity,
  safeEqualHex,
  signToken,
  USERNAME_PATTERN,
  verifyToken,
} from '../src/auth.js'

const SECRET = 'a'.repeat(128)

describe('token（HMAC-SHA256）', () => {
  it('签发 → 验签返回 userId', () => {
    const token = signToken('user-alice', SECRET)
    expect(verifyToken(token, SECRET)).toBe('user-alice')
  })

  it('过期 token 拒绝（exp 已过）', () => {
    const token = signToken('user-alice', SECRET, 1000, Date.now() - 2000)
    expect(verifyToken(token, SECRET)).toBeNull()
  })

  it('密钥不符 / 篡改 payload / 形状坏 → null', () => {
    const token = signToken('user-alice', SECRET)
    expect(verifyToken(token, 'b'.repeat(128))).toBeNull()
    const [payload, mac] = token.split('.')
    expect(verifyToken(`${payload}x.${mac}`, SECRET)).toBeNull()
    expect(verifyToken('not-a-token', SECRET)).toBeNull()
    expect(verifyToken('a.b.c', SECRET)).toBeNull()
    expect(verifyToken('', SECRET)).toBeNull()
  })
})

describe('密码（scrypt + 恒时比较）', () => {
  it('同密码同 salt 同哈希；不同 salt 不同哈希', () => {
    const h1 = hashPassword('hunter2222', '0011')
    expect(hashPassword('hunter2222', '0011')).toBe(h1)
    expect(hashPassword('hunter2222', '0022')).not.toBe(h1)
    expect(safeEqualHex(h1, h1)).toBe(true)
    expect(safeEqualHex(h1, hashPassword('wrong-pass', '0011'))).toBe(false)
  })
})

describe('resolveIdentity（优先级与宽松格式）', () => {
  it('Bearer token 优先于 x-loom-user', () => {
    const token = signToken('user-bob', SECRET)
    const identity = resolveIdentity({
      authorization: `Bearer ${token}`,
      xLoomUser: 'anon-someone-else-1',
      secret: SECRET,
    })
    expect(identity).toEqual({ userId: 'user-bob', kind: 'local' })
  })

  it('?token= query 等价解析（SSE 场景）', () => {
    const token = signToken('user-bob', SECRET)
    expect(resolveIdentity({ tokenQuery: token, secret: SECRET })).toEqual({ userId: 'user-bob', kind: 'local' })
  })

  it('x-loom-user / ?user= 匿名分支（宽松格式校验）', () => {
    expect(resolveIdentity({ xLoomUser: 'anon-e2e-fixed-0001', secret: SECRET })).toEqual({ userId: 'anon-e2e-fixed-0001', kind: 'anon' })
    expect(resolveIdentity({ userQuery: 'anon-abcdefgh', secret: SECRET })).toEqual({ userId: 'anon-abcdefgh', kind: 'anon' })
    expect(resolveIdentity({ xLoomUser: 'bad id!', secret: SECRET })).toBeNull()
    expect(resolveIdentity({ xLoomUser: 'short', secret: SECRET })).toBeNull()
    expect(resolveIdentity({ secret: SECRET })).toBeNull()
  })

  it('token 验签失败回落匿名头', () => {
    expect(resolveIdentity({ authorization: 'Bearer garbage.token', xLoomUser: 'anon-fallback-0001', secret: SECRET }))
      .toEqual({ userId: 'anon-fallback-0001', kind: 'anon' })
  })

  it('无 secret（app.auth 未声明）时 token 分支跳过', () => {
    expect(resolveIdentity({ authorization: `Bearer ${signToken('user-bob', SECRET)}`, secret: undefined })).toBeNull()
  })

  it('newAnonUserId 形如 anon-<uuid>', () => {
    expect(newAnonUserId()).toMatch(/^anon-[0-9a-f-]{36}$/)
    expect(USERNAME_PATTERN.test('ali')).toBe(true)
    expect(USERNAME_PATTERN.test('ab')).toBe(false)
  })
})

describe('AccountStore（临时目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-auth-test-'))
  const store = new AccountStore(join(dir, 'accounts.json'), join(dir, 'auth-secret'))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('hmacSecret 首次生成并持久化（二次读取一致）', async () => {
    const first = await store.hmacSecret()
    expect(first).toMatch(/^[0-9a-f]{128}$/)
    const second = await new AccountStore(join(dir, 'accounts.json'), join(dir, 'auth-secret')).hmacSecret()
    expect(second).toBe(first)
  })

  it('注册 → 登录成功返回 userId；重复注册如实报错', async () => {
    const registered = await store.register('alice', 'password88')
    expect(registered.ok).toBe(true)
    expect(registered.userId).toBe('user-alice')
    const again = await store.register('alice', 'password99')
    expect(again.ok).toBe(false)
    expect(again.error).toContain('已被注册')
    const login = await store.login('alice', 'password88')
    expect(login.ok).toBe(true)
    expect(login.userId).toBe('user-alice')
  })

  it('用户名/密码规则校验（中文错误）', async () => {
    const badName = await store.register('x', 'password88')
    expect(badName.ok).toBe(false)
    expect(badName.error).toContain('用户名')
    const badPassword = await store.register('bob', 'short')
    expect(badPassword.ok).toBe(false)
    expect(badPassword.error).toContain('密码')
  })

  it('登录失败不泄露用户名存在性（统一文案）', async () => {
    const wrongPassword = await store.login('alice', 'wrong-password')
    const unknownUser = await store.login('who-is-this', 'password88')
    expect(wrongPassword.error).toBe('用户名或密码不正确')
    expect(unknownUser.error).toBe('用户名或密码不正确')
  })

  it('usernameOf 反查', async () => {
    expect(await store.usernameOf('user-nobody-here')).toBeNull()
    await store.register('carol', 'password88')
    expect(await store.usernameOf('user-carol')).toBe('carol')
  })
})

describe('QA #15 回归：匿名身份不可携带本地账号命名空间前缀', () => {
  it('x-loom-user / ?user= 携带 user- 前缀一律拒绝（防冒充本地账号）', () => {
    // 修复前：'user-alice' 满足 ANON_ID_PATTERN，会被当作匿名身份接受且
    // userId 与本地账号 alice 完全一致——任何人可冒充 alice 越权读写。
    expect(resolveIdentity({ xLoomUser: 'user-alice', secret: undefined })).toBeNull()
    expect(resolveIdentity({ userQuery: 'user-admin', secret: undefined })).toBeNull()
    expect(resolveIdentity({ xLoomUser: 'user-a', secret: undefined })).toBeNull()
    // hook: 机器身份含冒号，本就不满足字符集
    expect(resolveIdentity({ userQuery: 'hook:/hooks/demo', secret: undefined })).toBeNull()
    // 合法匿名身份不受影响
    expect(resolveIdentity({ xLoomUser: 'anon-abc-def-1234', secret: undefined })).toEqual({ userId: 'anon-abc-def-1234', kind: 'anon' })
    expect(resolveIdentity({ userQuery: 'anon-qa-matrix-0001', secret: undefined })).toEqual({ userId: 'anon-qa-matrix-0001', kind: 'anon' })
    // 生成器产物永远合法
    for (let i = 0; i < 50; i++) {
      const id = newAnonUserId()
      expect(resolveIdentity({ xLoomUser: id, secret: undefined })).toEqual({ userId: id, kind: 'anon' })
    }
  })

  it('伪造 user- 头不能越过 Bearer 的优先身份（token 仍最高优先）', () => {
    const token = signToken('user-alice', SECRET)
    expect(resolveIdentity({ authorization: `Bearer ${token}`, xLoomUser: 'user-bob', secret: SECRET }))
      .toEqual({ userId: 'user-alice', kind: 'local' })
  })
})
