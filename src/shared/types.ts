export interface OssProfile {
  id: string
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  hasSecret: boolean
  isDefault: boolean
}

export interface UploadPreset {
  id: string
  name: string
  description?: string
  profileId: string
  bucket: string
  prefix: string
  isDefault: boolean
}

export interface AppConfig {
  profiles: OssProfile[]
  presets: UploadPreset[]
  concurrentUploads: number
  conflictStrategy: 'overwrite' | 'skip'
}

export interface ProfileInput extends Omit<OssProfile, 'hasSecret'> {
  accessKeySecret?: string
  hasSecret?: boolean
}

export interface LocalUploadItem {
  id: string
  absolutePath: string
  relativePath: string
  name: string
  size: number
}

export interface UploadRequest {
  taskId: string
  absolutePath: string
  objectName: string
  profileId: string
  bucket: string
  conflictStrategy: 'overwrite' | 'skip'
}

export interface OssObjectItem {
  key: string
  name: string
  size: number
  lastModified?: string
  isFolder: boolean
}

export interface OssBucketItem {
  name: string
  region?: string
  creationDate?: string
}

export interface ListObjectsRequest {
  profileId: string
  bucket: string
  prefix: string
  region?: string
}

export interface DownloadObjectsRequest extends ListObjectsRequest {
  keys: string[]
}

export interface UploadProgressEvent {
  taskId: string
  percent: number
  loaded: number
  total: number
}

export interface DesktopApi {
  getConfig: () => Promise<AppConfig>
  saveProfile: (profile: ProfileInput) => Promise<AppConfig>
  deleteProfile: (id: string) => Promise<AppConfig>
  savePreset: (preset: UploadPreset) => Promise<AppConfig>
  deletePreset: (id: string) => Promise<AppConfig>
  savePreferences: (input: Pick<AppConfig, 'concurrentUploads' | 'conflictStrategy'>) => Promise<AppConfig>
  testConnection: (profile: ProfileInput) => Promise<{ ok: boolean; message: string }>
  selectFiles: () => Promise<LocalUploadItem[]>
  selectFolder: () => Promise<LocalUploadItem[]>
  upload: (request: UploadRequest) => Promise<{ skipped?: boolean }>
  cancelAllUploads: () => Promise<{ cancelled: number }>
  listObjects: (request: ListObjectsRequest) => Promise<OssObjectItem[]>
  listBuckets: (profileId: string) => Promise<OssBucketItem[]>
  downloadObjects: (request: DownloadObjectsRequest) => Promise<{ directory: string; count: number } | { cancelled: true }>
  copyText: (text: string) => Promise<void>
  onUploadProgress: (callback: (event: UploadProgressEvent) => void) => () => void
}
