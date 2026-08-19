import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { promises as fs, createWriteStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import OSS from 'ali-oss'
import type { AppConfig, DeleteObjectsRequest, DownloadObjectsRequest, FolderTreeNode, GetObjectUrlRequest, ListObjectsRequest, LocalUploadItem, PathCategory, ProfileInput, RenameObjectRequest, TransferObjectsRequest, UploadPreset, UploadRequest } from '../shared/types'

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
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    // 部分目录可能无权限读取，视为空目录继续扫描
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
async function expandObjectKeys(client: InstanceType<typeof OSS>, keys: string[]): Promise<string[]> {
  const result: string[] = []
  for (const key of keys) {
    if (!key.endsWith('/')) {
      result.push(key)
      continue
    }
    let marker: string | undefined
    do {
      const page = await client.list({ prefix: key, 'max-keys': 1000, ...(marker ? { marker } : {}) })
      for (const object of page.objects || []) {
        if (object.name !== key) result.push(object.name)
      }
      marker = page.isTruncated ? page.nextMarker : undefined
    } while (marker)
  }
  return result
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

  ipcMain.handle('clipboard:write', (_event, value: string) => clipboard.writeText(value))

  ipcMain.handle('oss:list-objects', async (_event, request: ListObjectsRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const prefix = request.prefix ? `${request.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
    const client = createClient(profile, request.bucket, undefined, request.region)
    const result = await client.list({ prefix, delimiter: '/', 'max-keys': 1000 })
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
    return [...folders, ...objects].sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))
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

  ipcMain.handle('oss:download-objects', async (_event, request: DownloadObjectsRequest) => {
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
        const page = await client.list({ prefix: folderPrefix, 'max-keys': 1000, ...(marker ? { marker } : {}) })
        for (const object of page.objects || []) {
          if (object.name !== folderPrefix && !object.name.endsWith('/')) keys.add(object.name)
        }
        marker = page.isTruncated ? page.nextMarker : undefined
      } while (marker)
    }

    for (const key of keys) {
      const relative = (key.startsWith(basePrefix) ? key.slice(basePrefix.length) : path.basename(key))
        .split('/').filter((part) => part && part !== '.' && part !== '..').join(path.sep)
      const destination = path.join(directory, relative)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const response = await client.getStream(key)
      if (!response.stream) throw new Error(`无法读取对象：${key}`)
      await pipeline(response.stream as NodeJS.ReadableStream, createWriteStream(destination))
    }
    return { directory, count: keys.size, folderCount: request.folderKeys.length }
  })

  ipcMain.handle('oss:delete-objects', async (_event, request: DeleteObjectsRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    const keys = await expandObjectKeys(client, request.keys)
    for (const key of keys) await client.delete(key)
    return { deleted: keys.length }
  })

  ipcMain.handle('oss:rename-object', async (_event, request: RenameObjectRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    const newName = request.newName.trim()
    if (!newName) throw new Error('新名称不能为空')
    if (/[\\/]/.test(newName)) throw new Error('新名称不能包含 / 或 \\')
    const isFolder = request.key.endsWith('/')
    const withSlash = request.key.slice(0, -1)
    const destKey = isFolder
      ? `${(withSlash.includes('/') ? request.key.slice(0, withSlash.lastIndexOf('/') + 1) : '')}${newName}/`
      : `${(request.key.includes('/') ? request.key.slice(0, request.key.lastIndexOf('/') + 1) : '')}${newName}`
    if (destKey === request.key) throw new Error('新名称与原名称相同')
    const objects = isFolder ? await expandObjectKeys(client, [request.key]) : [request.key]
    for (const object of objects) {
      if (isFolder) {
        const rel = object.slice(request.key.length)
        const targetKey = [destKey.slice(0, -1), rel].filter(Boolean).join('/')
        await client.copy(targetKey, object)
        await client.delete(object)
      } else {
        await client.copy(destKey, object)
        await client.delete(object)
      }
    }
    return { key: destKey }
  })

  ipcMain.handle('oss:transfer-objects', async (_event, request: TransferObjectsRequest) => {
    const config = await readConfig()
    const profile = config.profiles.find((item) => item.id === request.profileId)
    if (!profile) throw new Error('OSS 配置不存在')
    const client = createClient(profile, request.bucket, undefined, request.region)
    const destPrefix = request.destinationPrefix.trim().replace(/^\/+|\/+$/g, '')
    let count = 0
    for (const sourceKey of request.sourceKeys) {
      if (sourceKey.endsWith('/')) {
        const folderName = sourceKey.slice(0, -1).split('/').pop() || ''
        const folderDestPrefix = [destPrefix, folderName].filter(Boolean).join('/')
        const objects = await expandObjectKeys(client, [sourceKey])
        for (const object of objects) {
          const rel = object.slice(sourceKey.length)
          const targetKey = [folderDestPrefix, rel].filter(Boolean).join('/')
          if (targetKey === object) throw new Error(`目标位置与原位置相同：${object}`)
          await client.copy(targetKey, object)
          if (request.mode === 'move') await client.delete(object)
          count += 1
        }
      } else {
        const name = sourceKey.split('/').pop() || ''
        const targetKey = [destPrefix, name].filter(Boolean).join('/')
        if (targetKey === sourceKey) throw new Error(`目标位置与原位置相同：${sourceKey}`)
        await client.copy(targetKey, sourceKey)
        if (request.mode === 'move') await client.delete(sourceKey)
        count += 1
      }
    }
    return { count }
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
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
