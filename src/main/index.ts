import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import OSS from 'ali-oss'
import type { AppConfig, LocalUploadItem, ProfileInput, UploadPreset, UploadRequest } from '../shared/types'

interface StoredProfile extends Omit<ProfileInput, 'accessKeySecret' | 'hasSecret'> {
  encryptedSecret?: string
}

interface StoredConfig {
  profiles: StoredProfile[]
  presets: UploadPreset[]
  concurrentUploads: number
  conflictStrategy: 'overwrite' | 'skip'
}

const defaultConfig: StoredConfig = {
  profiles: [],
  presets: [],
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

function createClient(profile: StoredProfile, bucket?: string, secretOverride?: string): InstanceType<typeof OSS> {
  return new OSS({
    accessKeyId: profile.accessKeyId,
    accessKeySecret: secretOverride || decryptSecret(profile),
    region: profile.region || undefined,
    endpoint: profile.endpoint || undefined,
    bucket,
    secure: true,
    timeout: 120000
  })
}

async function scanFolder(root: string, current = root): Promise<LocalUploadItem[]> {
  const entries = await fs.readdir(current, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(current, entry.name)
    if (entry.isDirectory()) return scanFolder(root, absolutePath)
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
    const preset = { ...input, name: input.name.trim(), bucket: input.bucket.trim(), prefix: input.prefix.trim().replace(/^\/+|\/+$/g, '') }
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

  ipcMain.handle('folder:select', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return []
    return scanFolder(result.filePaths[0])
  })

  ipcMain.handle('clipboard:write', (_event, value: string) => clipboard.writeText(value))

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
