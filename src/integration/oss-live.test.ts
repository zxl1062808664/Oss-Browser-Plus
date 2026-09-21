import { randomUUID } from 'node:crypto'
import OSS from 'ali-oss'
import { describe, expect, it } from 'vitest'
import { buildFolderKey, buildRenameDestination, normalizeObjectPrefix } from '../shared/oss-operations'

const REQUIRED_CONFIRMATION = 'YES_I_UNDERSTAND'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

async function listAll(client: InstanceType<typeof OSS>, prefix: string, maxKeys = 1000): Promise<string[]> {
  const keys: string[] = []
  let marker: string | undefined
  do {
    const page = await client.list({ prefix, 'max-keys': maxKeys, ...(marker ? { marker } : {}) })
    keys.push(...(page.objects || []).map((object) => object.name))
    marker = page.isTruncated ? page.nextMarker : undefined
  } while (marker)
  return keys
}

async function cleanupPrefix(client: InstanceType<typeof OSS>, prefix: string): Promise<void> {
  const keys = await listAll(client, prefix)
  for (let index = 0; index < keys.length; index += 100) {
    await client.deleteMulti(keys.slice(index, index + 100))
  }
}

describe('真实 OSS 受控联调', () => {
  it('验证目录标记、分页、复制、移动、重命名和删除', async () => {
    if (process.env.OSS_TEST_CONFIRM !== REQUIRED_CONFIRMATION) {
      throw new Error(`拒绝执行真实 OSS 写入：请显式设置 OSS_TEST_CONFIRM=${REQUIRED_CONFIRMATION}`)
    }

    const accessKeyId = requiredEnv('OSS_TEST_ACCESS_KEY_ID')
    const accessKeySecret = requiredEnv('OSS_TEST_ACCESS_KEY_SECRET')
    const bucket = requiredEnv('OSS_TEST_BUCKET')
    const region = process.env.OSS_TEST_REGION?.trim()
    const endpoint = process.env.OSS_TEST_ENDPOINT?.trim()
    if (!region && !endpoint) throw new Error('OSS_TEST_REGION 和 OSS_TEST_ENDPOINT 至少设置一个')

    const configuredPrefix = normalizeObjectPrefix(process.env.OSS_TEST_PREFIX || 'oss-quick-test')
    if (configuredPrefix !== 'oss-quick-test' && !configuredPrefix.startsWith('oss-quick-test/')) {
      throw new Error('OSS_TEST_PREFIX 必须是 oss-quick-test 或其子目录')
    }

    const runPrefix = `${configuredPrefix}/run-${Date.now()}-${randomUUID().slice(0, 8)}/`
    const client = new OSS({ accessKeyId, accessKeySecret, bucket, region, endpoint, secure: true, timeout: 120000 })

    try {
      const sourceFolder = buildFolderKey(runPrefix, 'source')
      const nestedFolder = buildFolderKey(sourceFolder, 'nested')
      const sourceFile = `${sourceFolder}file.txt`
      const nestedFile = `${nestedFolder}data.json`
      await client.put(sourceFolder, Buffer.alloc(0))
      await client.put(nestedFolder, Buffer.alloc(0))
      await client.put(sourceFile, Buffer.from('oss-live-test'))
      await client.put(nestedFile, Buffer.from('{"ok":true}'))

      const pagedKeys = await listAll(client, runPrefix, 2)
      expect(pagedKeys).toEqual(expect.arrayContaining([sourceFolder, nestedFolder, sourceFile, nestedFile]))

      const createdFolder = buildFolderKey(runPrefix, 'created')
      await client.put(createdFolder, Buffer.alloc(0))
      await expect(client.head(createdFolder)).resolves.toBeDefined()

      const copiedFile = `${runPrefix}copied/file.txt`
      await client.copy(copiedFile, sourceFile)
      await expect(client.head(copiedFile)).resolves.toBeDefined()

      const renamedFile = buildRenameDestination(sourceFile, 'renamed.txt')
      await client.copy(renamedFile, sourceFile)
      await client.delete(sourceFile)
      await expect(client.head(renamedFile)).resolves.toBeDefined()
      await expect(client.head(sourceFile)).rejects.toMatchObject({ status: 404 })

      const movedFile = `${runPrefix}moved/data.json`
      await client.copy(movedFile, nestedFile)
      await client.delete(nestedFile)
      await expect(client.head(movedFile)).resolves.toBeDefined()
      await expect(client.head(nestedFile)).rejects.toMatchObject({ status: 404 })

      const sourceKeys = await listAll(client, sourceFolder)
      expect(sourceKeys).toEqual(expect.arrayContaining([sourceFolder, nestedFolder, renamedFile]))
      await client.deleteMulti(sourceKeys)
      expect(await listAll(client, sourceFolder)).toEqual([])
    } finally {
      await cleanupPrefix(client, runPrefix)
    }
  }, 120000)
})
