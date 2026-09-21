import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { promises as fs, createWriteStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import OSS from 'ali-oss'
import type { AppConfig, CreateFolderRequest, DeleteObjectsRequest, DownloadObjectsRequest, FolderTreeNode, GetObjectUrlRequest, ListObjectsPageRequest, ListObjectsRequest, LocalUploadItem, ObjectPreview, PathCategory, PreviewObjectRequest, ProfileInput, RenameObjectRequest, TransferObjectsRequest, UploadPreset, UploadRequest } from '../shared/types'
import { buildFolderKey, buildRenameDestination, buildRenameObjectTarget, buildTransferPairs, classifyObjectPreview, normalizeObjectPrefix } from '../shared/oss-operations'

interface StoredProfile extends Omit<ProfileInput, 'accessKeySecret' | 'hasSecret'> {
  encryptedSecret?: string
}

interface StoredConfig {
  profiles: StoredProfile[]
  presets: UploadPreset[]
  categories: PathCategory[]
  concurrentUploads: number
  conflictStrategy: 'overwrite' | 'skip'
}

const defaultConfig: StoredConfig = {
  profiles: [],
  presets: [],
  categories: [],
  concurrentUploads: 3,
  conflictStrategy: 'overwrite'
}

const activeUploadClients = new Map<string, InstanceType<typeof OSS>>()
const activeObjectOperationSenders = new Set<number>()
const cancelledObjectOperationSenders = new Set<number>()

class OperationCancelledError extends Error {
  constructor() {
    super('操作已取消，已完成的对象不会回滚')
  }
}

function assertObjectOperationActive(senderId: number): void {
  if (cancelledObjectOperationSenders.has(senderId)) throw new OperationCancelledError()
}

function rethrowIfOperationCancelled(error: unknown): void {
  if (error instanceof OperationCancelledError) throw error
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof OperationCancelledError) return false
  const status = (error as { status?: number }).status
  return !status || status === 408 || status === 429 || status >= 500
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isRetryableError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
  }
  throw lastError
}

const configPath = () => path.join(app.getPath('userData'), 'config.json')

async function readConfig(): Promise<StoredConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    return { ...defaultConfig, ...JSON.parse(raw) }
  } catch {
    return structuredClone(defaultConfig)
  }
}

async function writeConfig(config: StoredConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
}

function publicConfig(config: StoredConfig): AppConfig {
  return {
    ...config,
    profiles: config.profiles.map(({ encryptedSecret, ...profile }) => ({
      ...profile,
      hasSecret: Boolean(encryptedSecret)
    }))
  }
}

function encryptSecret(secret: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存 AccessKey Secret')
  return safeStorage.encryptString(secret).toString('base64')
}

function decryptSecret(profile: StoredProfile): string {
  if (!profile.encryptedSecret) throw new Error('该 OSS 配置缺少 AccessKey Secret')
  return safeStorage.decryptString(Buffer.from(profile.encryptedSecret, 'base64'))
}

/** 批量删除每批的对象数（OSS deleteMulti 上限 1000，取 100 让进度更平滑） */
const DELETE_BATCH_SIZE = 100

function createClient(profile: StoredProfile, bucket?: string, secretOverride?: string, regionOverride?: string): InstanceType<typeof OSS> {
  return new OSS({
    accessKeyId: profile.accessKeyId,
    accessKeySecret: secretOverride || decryptSecret(profile),
    region: regionOverride || profile.region || undefined,
    endpoint: regionOverride ? undefined : profile.endpoint || undefined,
    bucket,
    secure: true,
    timeout: 120000
  })
}

/**
 * 递归扫描本地目录，构建目录树（含大小、文件数汇总）。
 * 供上传中心的文件夹选择弹窗展示，支持多级浏览勾选。
 */
async function scanTree(current: string, relative = ''): Promise<FolderTreeNode> {
  let entries: Dirent[] = []
  let scanWarnings = 0
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    scanWarnings = 1
  }
  const scanned = await Promise.all(entries.map(async (entry): Promise<FolderTreeNode | null> => {
    const absolutePath = path.join(current, entry.name)
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const child = await scanTree(absolutePath, entryRelative)
      return { ...child, name: entry.name, relativePath: entryRelative, absolutePath }
    }
    if (entry.isFile()) {
      const stat = await fs.stat(absolutePath)
      return { name: entry.name, relativePath: entryRelative, absolutePath, isFolder: false, size: stat.size, fileCount: 1, children: [] }
    }
    return null
  }))
  const children = scanned.filter((node): node is FolderTreeNode => node !== null)
  return {
    name: path.basename(current) || current,
    relativePath: relative,
    absolutePath: current,
    isFolder: true,
    size: children.reduce((sum, node) => sum + node.size, 0),
    fileCount: children.reduce((sum, node) => sum + node.fileCount, 0),
    scanWarnings: scanWarnings + children.reduce((sum, node) => sum + (node.scanWarnings || 0), 0),
    children
  }
}

/** 递归收集单个选中节点（文件或文件夹）下的所有文件，relativePath 从该节点开始，保留层级结构 */
async function scanSelection(absolute: string, relative: string): Promise<LocalUploadItem[]> {
  const stat = await fs.stat(absolute)
  if (!stat.isDirectory()) {
    return [{ id: randomUUID(), absolutePath: absolute, relativePath: relative, name: path.basename(absolute), size: stat.size }]
  }
  let entries
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const childAbsolute = path.join(absolute, entry.name)
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) return scanSelection(childAbsolute, childRelative)
    if (!entry.isFile()) return []
    const fileStat = await fs.stat(childAbsolute)
    return [{
      id: randomUUID(),
      absolutePath: childAbsolute,
      relativePath: childRelative,
      name: entry.name,
      size: fileStat.size
    }]
  }))
  return nested.flat()
}

/** 把用户勾选的若干节点展开为上传任务列表；若勾选节点存在祖先也被勾选，只取最顶层节点避免重复 */
async function collectSelection(root: string, selectedPaths: string[]): Promise<LocalUploadItem[]> {
  const sorted = [...selectedPaths].sort((a, b) => a.split('/').length - b.split('/').length)
  const topLevel: string[] = []
  for (const candidate of sorted) {
    const covered = topLevel.some((ancestor) =>
      candidate === ancestor || ancestor === '' || candidate.startsWith(`${ancestor}/`))
    if (covered) continue
    topLevel.push(candidate)
  }
  const items: LocalUploadItem[] = []
  for (const relativePath of topLevel) {
    items.push(...await scanSelection(path.join(root, ...relativePath.split('/')), relativePath))
  }
  return items
}

/** 把文件/文件夹 key 展开为实际对象 key 列表（文件夹按前缀递归获取其下全部对象） */
/**
 * 把 key 列表里以 / 结尾的文件夹递归展开成具体对象 key。
 * onScan 用于上报扫描进度（删除大文件夹时列出所有对象可能耗时较久）。
 */
async function expandObjectKeys(
  client: InstanceType<typeof OSS>,
  keys: string[],
  onScan?: (scanned: number) => void,
  assertActive?: () => void
): Promise<string[]> {
  const result: string[] = []
  for (const key of keys) {
    assertActive?.()
    if (!key.endsWith('/')) {
      result.push(key)
      continue
    }
    let marker: string | undefined
    do {
      assertActive?.()
      const page = await withRetry(() => client.list({ prefix: key, 'max-keys': 1000, ...(marker ? { marker } : {}) }))
      for (const object of page.objects || []) {
        // 目录标记对象也要纳入操作，否则空目录或旧目录标记会残留。
        result.push(object.name)
      }
      marker = page.isTruncated ? page.nextMarker : undefined
      onScan?.(result.length)
    } while (marker)
  }
  return result
}

async function objectExists(client: InstanceType<typeof OSS>, key: string): Promise<boolean> {
  try {
    await withRetry(() => client.head(key))
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 404) return false
    throw error
  }
}

async function prefixExists(client: InstanceType<typeof OSS>, prefix: string): Promise<boolean> {
  const result = await withRetry(() => client.list({ prefix, 'max-keys': 1 }))
  return Boolean(result.objects?.length)
}

async function listObjectPage(client: InstanceType<typeof OSS>, request: ListObjectsPageRequest) {
  const prefix = request.prefix ? `${request.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  const result = await withRetry(() => client.list({ prefix, delimiter: '/', 'max-keys': 1000, ...(request.marker ? { marker: request.marker } : {}) }))
  const folders = (result.prefixes || []).map((key) => ({
    key,
    name: key.slice(prefix.length).replace(/\/$/, ''),
    size: 0,
    isFolder: true
  }))
  const objects = (result.objects || [])
    .filter((object) => object.name !== prefix)
    .map((object) => ({
      key: object.name,
      name: object.name.slice(prefix.length),
      size: object.size || 0,
      lastModified: object.lastModified ? new Date(object.lastModified).toISOString() : undefined,
      isFolder: false
    }))
  return {
    items: [...folders, ...objects].sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name)),
    nextMarker: result.isTruncated ? result.nextMarker : undefined
  }
}

/** 递归扫描本地文件夹为上传任务，relativePath 以文件夹名开头，保留完整层级 */
async function scanUploadFolder(root: string, current = root): Promise<LocalUploadItem[]> {
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(current, entry.name)
    if (entry.isDirectory()) return scanUploadFolder(root, absolutePath)
    if (!entry.isFile()) return []
    const stat = await fs.stat(absolutePath)
    return [{
      id: randomUUID(),
      absolutePath,
      relativePath: path.join(path.basename(root), path.relative(root, absolutePath)).replaceAll('\\', '/'),
      name: entry.name,
      size: stat.size
    }]
  }))
  return nested.flat()
}

/** 构造对象公开访问 URL（不签名、长期有效；仅当 Bucket 为公共读时可访问） */
function objectPublicUrl(bucket: string, region: string, endpoint: string, key: string): string {
  const host = region ? `${region}.aliyuncs.com` : endpoint
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `https://${bucket}.${host}/${encodedKey}`
}

/** 双击预览的大小上限：文本超限提示下载查看，避免拉大文件；图片放宽到 20MB */
const TEXT_PREVIEW_LIMIT = 1024 * 1024
const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** 读取对象内容用于预览：先 HEAD 拿大小再决定是否下载，防止无脑拉取大对象 */
async function previewObject(request: PreviewObjectRequest): Promise<ObjectPreview> {
  const config = await readConfig()
  const profile = config.profiles.find((item) => item.id === request.profileId)
  if (!profile) throw new Error('OSS 配置不存在')
  if (request.key.endsWith('/')) throw new Error('文件夹不支持预览')
  const kind = classifyObjectPreview(request.key)
  if (!kind) throw new Error('该文件类型暂不支持预览')
  const client = createClient(profile, request.bucket, undefined, request.region)
  let size = 0
  try {
    const head = await withRetry(() => client.head(request.key))
    size = Number(head.res?.headers?.['content-length'] || 0)
  } catch (error) {
    if ((error as { status?: number }).status === 404) throw new Error('对象不存在或已被删除')
    throw error
  }
  if (kind === 'text') {
    if (size > TEXT_PREVIEW_LIMIT) throw new Error(`文件大小 ${(size / 1024 / 1024).toFixed(1)} MB，超过预览上限 1 MB，请下载后查看`)
    const result = await withRetry(() => client.get(request.key))
    const buffer = Buffer.from(result.content)
    // 扩展名是文本但内容含 NUL 字节，基本可判定为二进制文件
    if (buffer.includes(0)) throw new Error('该文件内容为二进制数据，不支持预览')
    return { kind, content: new TextDecoder('utf-8').decode(buffer) }
  }
  if (size > IMAGE_PREVIEW_LIMIT) throw new Error('图片超过 20 MB，暂不支持预览，请下载后查看')
  const result = await withRetry(() => client.get(request.key))
  const ext = (request.key.split('/').pop() || '').split('.').pop()?.toLowerCase() || ''
  return { kind, mimeType: IMAGE_MIME_TYPES[ext] || 'application/octet-stream', base64: Buffer.from(result.content).toString('base64') }
}

function registerIpc(): void {
  ipcMain.handle('config:get', async () => publicConfig(await readConfig()))

  ipcMain.handle('config:save-profile', async (_event, input: ProfileInput) => {
    const config = await readConfig()
    const existing = config.profiles.find((profile) => profile.id === input.id)
    const stored: StoredProfile = {
      id: input.id,
      name: input.name.trim(),
      endpoint: input.endpoint.trim().replace(/^https?:\/\//, ''),
      region: input.region.trim(),
      accessKeyId: input.accessKeyId.trim(),
      isDefault: input.isDefault,
      encryptedSecret: input.accessKeySecret ? encryptSecret(input.accessKeySecret) : existing?.encryptedSecret
    }
    if (stored.isDefault) config.profiles.forEach((profile) => { profile.isDefault = false })
    const index = config.profiles.findIndex((profile) => profile.id === stored.id)
    if (index >= 0) config.profiles[index] = stored
    else config.profiles.push(stored)
    if (config.profiles.length === 1) config.profiles[0].isDefault = true
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('config:delete-profile', async (_event, id: string) => {
    const config = await readConfig()
    config.profiles = config.profiles.filter((profile) => profile.id !== id)
    config.presets = config.presets.filter((preset) => preset.profileId !== id)
    if (config.profiles.length && !config.profiles.some((profile) => profile.isDefault)) config.profiles[0].isDefault = true
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('config:save-preset', async (_event, input: UploadPreset) => {
    const config = await readConfig()
    const preset = { ...input, name: input.name.trim(), description: input.description?.trim() || '', bucket: input.bucket.trim(), prefix: input.prefix.trim().replace(/^\/+|\/+$/g, '') }
    if (preset.isDefault) config.presets.forEach((item) => { item.isDefault = false })
    const index = config.presets.findIndex((item) => item.id === preset.id)
    if (index >= 0) config.presets[index] = preset
    else config.presets.push(preset)
    if (config.presets.length === 1) config.presets[0].isDefault = true
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('config:delete-preset', async (_event, id: string) => {
    const config = await readConfig()
    config.presets = config.presets.filter((preset) => preset.id !== id)
    if (config.presets.length && !config.presets.some((preset) => preset.isDefault)) config.presets[0].isDefault = true
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('config:save-category', async (_event, input: PathCategory) => {
    const config = await readConfig()
    const name = input.name.trim()
    if (!name) throw new Error('分类名称不能为空')
    const category: PathCategory = { id: input.id, name }
    const index = config.categories.findIndex((item) => item.id === category.id)
    if (index >= 0) config.categories[index] = category
    else config.categories.push(category)
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('config:delete-category', async (_event, id: string) => {
    const config = await readConfig()
    config.categories = config.categories.filter((item) => item.id !== id)
    config.presets.forEach((preset) => { if (preset.categoryId === id) preset.categoryId = undefined })
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('config:save-preferences', async (_event, input: Pick<AppConfig, 'concurrentUploads' | 'conflictStrategy'>) => {
    const config = await readConfig()
    config.concurrentUploads = Math.max(1, Math.min(8, input.concurrentUploads))
    config.conflictStrategy = input.conflictStrategy
    await writeConfig(config)
    return publicConfig(config)
  })

  ipcMain.handle('oss:test', async (_event, input: ProfileInput) => {
    try {
      const config = await readConfig()
      const existing = config.profiles.find((profile) => profile.id === input.id)
      const profile: StoredProfile = { ...input, encryptedSecret: existing?.encryptedSecret }
      await createClient(profile, undefined, input.accessKeySecret).listBuckets({ 'max-keys': 1 })
      return { ok: true, message: '连接成功，凭据可用' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '连接失败' }
    }
  })

  ipcMain.handle('files:select', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(async (absolutePath): Promise<LocalUploadItem> => {
      const stat = await fs.stat(absolutePath)
      return { id: randomUUID(), absolutePath, relativePath: path.basename(absolutePath), name: path.basename(absolutePath), size: stat.size }
    }))
  })

  ipcMain.handle('folder:pick-root', async () => {
    const result = await dialog.showOpenDialog({ title: '选择项目根文件夹', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('folder:tree', async (_event, root: string) => scanTree(root))

  ipcMain.handle('folder:collect', async (_event, root: string, selectedPaths: string[]) => collectSelection(root, selectedPaths))

  ipcMain.handle('folder:select-upload', async () => {
    const result = await dialog.showOpenDialog({ title: '选择要上传的文件夹', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return []
    return scanUploadFolder(result.filePaths[0])
  })

  /** 把拖入的本地路径（文件或文件夹，可混合）展开为上传任务列表 */
  ipcMain.handle('files:collect-from-paths', async (_event, paths: string[]) => {
    const items: LocalUploadItem[] = []
    for (const absolutePath of paths) {
      if (!absolutePath) continue
      const name = path.basename(absolutePath)
      items.push(...await scanSelection(absolutePath, name))
    }
    return items
  })

  ipcMain.handle('clipboard:write', (_event, value: string) => clipboard.writeText(value))

  ipcMain.handle('oss:set-operation-active', (event, active: boolean) => {
    if (active) {
      activeObjectOperationSenders.add(event.sender.id)
      cancelledObjectOperationSenders.delete(event.sender.id)
      event.sender.once('destroyed', () => {
        activeObjectOperationSenders.delete(event.sender.id)
        cancelledObjectOperationSenders.delete(event.sender.id)
      })
    } else {
      activeObjectOperationSenders.delete(event.sender.id)
      cancelledObjectOperationSenders.delete(event.sender.id)
    }
  })

  ipcMain.handle('oss:cancel-operation', (event) => {
    const cancelled = activeObjectOperationSenders.has(event.sender.id)
    if (cancelled) cancelledObjectOperationSenders.add(event.sender.id)
    return { cancelled }
  })

  ipcMain.handle('oss:list-objects-page', async (_event, request: ListObjectsPageRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    return listObjectPage(createClient(profile, request.bucket, undefined, request.region), request)
  })

  ipcMain.handle('oss:list-objects', async (_event, request: ListObjectsRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    return (await listObjectPage(createClient(profile, request.bucket, undefined, request.region), request)).items
  })

  ipcMain.handle('oss:list-buckets', async (_event, profileId: string) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const result = await createClient(profile).listBuckets({ 'max-keys': 1000 })
    return (result.buckets || []).map((bucket) => ({
      name: bucket.name,
      region: bucket.region,
      creationDate: bucket.creationDate ? new Date(bucket.creationDate).toISOString() : undefined
    })).sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('oss:create-folder', async (_event, request: CreateFolderRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const key = buildFolderKey(request.prefix, request.name)
    const client = createClient(profile, request.bucket, undefined, request.region)
    if (await objectExists(client, key.slice(0, -1)) || await prefixExists(client, key)) throw new Error('同名文件夹或对象已存在')
    await withRetry(() => client.put(key, Buffer.alloc(0)))
    return { key }
  })

  ipcMain.handle('oss:download-objects', async (event, request: DownloadObjectsRequest) => {
    const result = await dialog.showOpenDialog({ title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true as const }
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    const basePrefix = request.prefix ? `${request.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
    const directory = result.filePaths[0]
    const keys = new Set(request.keys)

    for (const folderKey of request.folderKeys) {
      const folderPrefix = `${folderKey.replace(/^\/+|\/+$/g, '')}/`
      const folderWithoutSlash = folderPrefix.slice(0, -1)
      const relativeFolder = folderWithoutSlash.startsWith(basePrefix)
        ? folderWithoutSlash.slice(basePrefix.length)
        : path.basename(folderWithoutSlash)
      const safeFolder = relativeFolder.split('/').filter((part) => part && part !== '.' && part !== '..').join(path.sep)
      await fs.mkdir(path.join(directory, safeFolder), { recursive: true })

      let marker: string | undefined
      do {
        assertObjectOperationActive(event.sender.id)
        const page = await withRetry(() => client.list({ prefix: folderPrefix, 'max-keys': 1000, ...(marker ? { marker } : {}) }))
        for (const object of page.objects || []) {
          if (object.name !== folderPrefix && !object.name.endsWith('/')) keys.add(object.name)
        }
        marker = page.isTruncated ? page.nextMarker : undefined
      } while (marker)
    }

    const keyList = Array.from(keys)
    let done = 0
    let failed = 0
    let skipped = 0
    const failedKeys: string[] = []
    for (const key of keyList) {
      assertObjectOperationActive(event.sender.id)
      const relative = (key.startsWith(basePrefix) ? key.slice(basePrefix.length) : path.basename(key))
        .split('/').filter((part) => part && part !== '.' && part !== '..').join(path.sep)
      const destination = path.join(directory, relative)
      try {
        if (request.conflictStrategy === 'skip') {
          try {
            await fs.access(destination)
            skipped += 1
            done += 1
            event.sender.send('oss:op-progress', { done, total: keyList.length, skipped, current: key })
            continue
          } catch {
            // 本地目标不存在，继续下载。
          }
        }
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await withRetry(async () => {
          assertObjectOperationActive(event.sender.id)
          const response = await client.getStream(key)
          if (!response.stream) throw new Error(`无法读取对象：${key}`)
          await pipeline(response.stream as NodeJS.ReadableStream, createWriteStream(destination))
        })
      } catch (error) {
        rethrowIfOperationCancelled(error)
        failed += 1
        failedKeys.push(key)
      }
      done += 1
      event.sender.send('oss:op-progress', { done, total: keyList.length, failed, skipped, current: key })
    }
    return { directory, count: keyList.length - failed - skipped, failed, skipped, failedKeys, folderCount: request.folderKeys.length }
  })

  ipcMain.handle('oss:delete-objects', async (event, request: DeleteObjectsRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    event.sender.send('oss:op-progress', { done: 0, total: 0, current: '正在扫描对象…' })
    const keys = await expandObjectKeys(client, request.keys, (scanned) => {
      event.sender.send('oss:op-progress', { done: 0, total: 0, current: `正在扫描对象… 已发现 ${scanned} 个` })
    }, () => assertObjectOperationActive(event.sender.id))

    let done = 0
    let failed = 0
    const failedKeys: string[] = []
    // 批量删除：每批最多 1000（OSS 上限），把上千次网络往返压到几十次
    for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
      assertObjectOperationActive(event.sender.id)
      const batch = keys.slice(index, index + DELETE_BATCH_SIZE)
      try {
        // 注意：不能用 quiet 模式——quiet 下 OSS 只返回失败的 <Error>，不返回 <Deleted>，
        // 那样 deleted 会是空数组，导致被误判为整批失败。
        const result = await withRetry(() => client.deleteMulti(batch))
        if (Array.isArray(result?.deleted)) {
          const deletedKeys = new Set(result.deleted.map((item) => item.Key).filter((key): key is string => Boolean(key)))
          const missing = batch.filter((key) => !deletedKeys.has(key))
          failed += missing.length
          failedKeys.push(...missing)
        }
      } catch {
        // 整批失败时退化为逐个删除，尽量删掉其余对象
        for (const key of batch) {
          assertObjectOperationActive(event.sender.id)
          try {
            await withRetry(() => client.delete(key))
          } catch {
            failed += 1
            failedKeys.push(key)
          }
        }
      }
      done += batch.length
      event.sender.send('oss:op-progress', { done, total: keys.length, failed })
    }
    return { deleted: keys.length - failed, failed, failedKeys }
  })

  ipcMain.handle('oss:rename-object', async (event, request: RenameObjectRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    const isFolder = request.key.endsWith('/')
    const destKey = buildRenameDestination(request.key, request.newName)
    event.sender.send('oss:op-progress', { done: 0, total: 0, current: '正在扫描对象…' })
    const objects = isFolder
      ? await expandObjectKeys(client, [request.key], (scanned) => {
        event.sender.send('oss:op-progress', { done: 0, total: 0, current: `正在扫描对象… 已发现 ${scanned} 个` })
      }, () => assertObjectOperationActive(event.sender.id))
      : [request.key]
    const collision = isFolder ? await prefixExists(client, destKey) : await objectExists(client, destKey)
    if (collision) throw new Error('目标名称已存在，请使用其他名称')
    let done = 0
    let failed = 0
    const failedKeys: string[] = []
    for (const object of objects) {
      assertObjectOperationActive(event.sender.id)
      try {
        if (isFolder) {
          const targetKey = buildRenameObjectTarget(request.key, destKey, object)
          await withRetry(() => client.copy(targetKey, object))
          await withRetry(() => client.delete(object))
        } else {
          await withRetry(() => client.copy(destKey, object))
          await withRetry(() => client.delete(object))
        }
      } catch {
        failed += 1
        failedKeys.push(object)
      }
      done += 1
      event.sender.send('oss:op-progress', { done, total: objects.length, failed, current: object })
    }
    return { key: destKey, failed, skipped: 0, failedKeys }
  })

  ipcMain.handle('oss:transfer-objects', async (event, request: TransferObjectsRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    const destPrefix = normalizeObjectPrefix(request.destinationPrefix)
    event.sender.send('oss:op-progress', { done: 0, total: 0, current: '正在扫描对象…' })

    // 先展开出全部待处理对象，避免处理过程中无法得知总量。
    const pairs: ReturnType<typeof buildTransferPairs> = []
    for (const sourceKey of request.sourceKeys) {
      const objects = sourceKey.endsWith('/')
        ? await expandObjectKeys(client, [sourceKey], (scanned) => {
          event.sender.send('oss:op-progress', { done: 0, total: 0, current: `正在扫描对象… 已发现 ${scanned} 个` })
        }, () => assertObjectOperationActive(event.sender.id))
        : [sourceKey]
      pairs.push(...buildTransferPairs(sourceKey, objects, destPrefix))
    }

    let count = 0
    let failed = 0
    let skipped = 0
    const failedKeys: string[] = []
    for (const pair of pairs) {
      assertObjectOperationActive(event.sender.id)
      try {
        const targetExists = (request.conflictStrategy || 'skip') === 'skip' && await objectExists(client, pair.target)
        assertObjectOperationActive(event.sender.id)
        if (targetExists) {
          skipped += 1
        } else {
          await withRetry(() => client.copy(pair.target, pair.source))
          if (request.mode === 'move') await withRetry(() => client.delete(pair.source))
          count += 1
        }
      } catch {
        failed += 1
        failedKeys.push(pair.source)
      }
      event.sender.send('oss:op-progress', {
        done: count + failed + skipped,
        total: pairs.length,
        failed,
        skipped,
        current: pair.source
      })
    }
    return { count, failed, skipped, failedKeys }
  })

  ipcMain.handle('oss:get-object-url', async (_event, request: GetObjectUrlRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    if (request.key.endsWith('/')) throw new Error('文件夹没有对象地址，请选择具体文件')
    const client = createClient(profile, request.bucket, undefined, request.region)
    return {
      signed: client.signatureUrl(request.key, { expires: request.expires || 3600 }),
      publicUrl: objectPublicUrl(request.bucket, request.region || profile.region, profile.endpoint, request.key)
    }
  })

  ipcMain.handle('oss:preview-object', (_event, request: PreviewObjectRequest) => previewObject(request))

  ipcMain.handle('oss:upload', async (event, request: UploadRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket)
    activeUploadClients.set(request.taskId, client)
    try {
      if (request.conflictStrategy === 'skip') {
        try {
          await client.head(request.objectName)
          return { skipped: true }
        } catch (error) {
          const status = (error as { status?: number }).status
          if (status !== 404) throw error
        }
      }
      await client.multipartUpload(request.objectName, request.absolutePath, {
        parallel: 4,
        partSize: 1024 * 1024,
        progress: async (percentage: number) => {
          const stat = await fs.stat(request.absolutePath)
          event.sender.send('oss:upload-progress', {
            taskId: request.taskId,
            percent: Math.round(percentage * 100),
            loaded: Math.round(stat.size * percentage),
            total: stat.size
          })
        }
      })
      return {}
    } finally {
      activeUploadClients.delete(request.taskId)
    }
  })

  ipcMain.handle('oss:cancel-all', () => {
    const cancelled = activeUploadClients.size
    activeUploadClients.forEach((client) => client.cancel())
    return { cancelled }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f4f6f8',
    title: 'OSS Quick Upload',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  let forceClose = false
  let closePromptOpen = false
  window.on('close', (event) => {
    if (forceClose || (!activeUploadClients.size && !activeObjectOperationSenders.size)) return
    event.preventDefault()
    if (closePromptOpen) return
    closePromptOpen = true
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: '仍有任务正在执行',
      message: '上传或 OSS 文件操作仍在执行，立即退出可能留下未完成任务。',
      detail: '建议继续等待任务结束。选择“仍然退出”会取消上传并关闭应用，已完成的对象不会回滚。',
      buttons: ['继续等待', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).then(({ response }) => {
      closePromptOpen = false
      if (response !== 1) return
      forceClose = true
      activeUploadClients.forEach((client) => client.cancel())
      window.close()
    })
  })
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
