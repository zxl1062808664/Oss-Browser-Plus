export interface OssProfile {
  id: string
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  hasSecret: boolean
  isDefault: boolean
}

export interface PathCategory {
  id: string
  name: string
}

export interface UploadPreset {
  id: string
  name: string
  description?: string
  profileId: string
  bucket: string
  prefix: string
  isDefault: boolean
  categoryId?: string
}

export interface AppConfig {
  profiles: OssProfile[]
  presets: UploadPreset[]
  categories: PathCategory[]
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

export interface FolderTreeNode {
  name: string
  /** 相对项目根目录的路径，统一使用 / 分隔，根节点为 '' */
  relativePath: string
  absolutePath: string
  isFolder: boolean
  /** 文件夹为其下所有文件大小之和 */
  size: number
  /** 文件夹为其下所有文件数量之和 */
  fileCount: number
  /** 无权限或读取失败的目录数量 */
  scanWarnings?: number
  children: FolderTreeNode[]
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

export type ObjectConflictStrategy = 'overwrite' | 'skip'

export interface ListObjectsPageRequest extends ListObjectsRequest {
  marker?: string
}

export interface ListObjectsPage {
  items: OssObjectItem[]
  nextMarker?: string
}

export interface DownloadObjectsRequest extends ListObjectsRequest {
  keys: string[]
  folderKeys: string[]
  conflictStrategy?: ObjectConflictStrategy
}

export interface OssMutationRequest {
  profileId: string
  bucket: string
  region?: string
}

export interface DeleteObjectsRequest extends OssMutationRequest {
  /** 对象 key 或文件夹 key（以 / 结尾），文件夹会递归删除其下所有对象 */
  keys: string[]
}

export interface RenameObjectRequest extends OssMutationRequest {
  /** 对象或文件夹 key */
  key: string
  /** 新名称（最后一段，不含 /；文件夹重命名会递归处理其下对象） */
  newName: string
}

export interface TransferObjectsRequest extends OssMutationRequest {
  /** 对象或文件夹 key 列表 */
  sourceKeys: string[]
  /** 目标目录前缀（可为空 = Bucket 根目录） */
  destinationPrefix: string
  mode: 'copy' | 'move'
  conflictStrategy?: ObjectConflictStrategy
}

export interface CreateFolderRequest extends OssMutationRequest {
  /** 当前目录前缀 */
  prefix: string
  /** 新文件夹名称，不含 / */
  name: string
}

export interface GetObjectUrlRequest extends OssMutationRequest {
  key: string
  /** 链接有效期（秒），默认 3600 */
  expires?: number
}

export interface PreviewObjectRequest extends OssMutationRequest {
  key: string
}

/**
 * 保存文本对象内容的请求。
 * etag 为打开预览时拿到的对象 ETag，用于 If-Match 条件写入，避免覆盖他人的并发修改。
 */
export interface SaveObjectRequest extends OssMutationRequest {
  key: string
  content: string
  etag?: string
}

/** 文件预览结果：文本按 UTF-8 解码后返回，图片返回 base64（渲染层拼 data URL） */
export type ObjectPreview =
  | {
    kind: 'text'
    content: string
    /** 读取时的对象 ETag，保存时回传做并发校验 */
    etag?: string
    /** 对象原始字节数，渲染层据此决定是否允许编辑 */
    size: number
  }
  | { kind: 'image'; mimeType: string; base64: string }

/** 保存结果：返回新的 ETag 与写入字节数，便于渲染层更新基线继续编辑 */
export interface SaveObjectResult {
  etag?: string
  size: number
}

export interface UploadProgressEvent {
  taskId: string
  percent: number
  loaded: number
  total: number
}

/** 批量操作（删除 / 复制 / 移动 / 下载 / 重命名）的进度事件 */
export interface OpProgressEvent {
  /** 已完成的对象数 */
  done: number
  /** 需要处理的总对象数 */
  total: number
  /** 当前正在处理的对象 key，用于展示文件名 */
  current?: string
  /** 失败数量（删除等批量操作可能部分失败） */
  failed?: number
  /** 跳过数量（下载或复制目标已存在时） */
  skipped?: number
}

export interface DesktopApi {
  getConfig: () => Promise<AppConfig>
  saveProfile: (profile: ProfileInput) => Promise<AppConfig>
  deleteProfile: (id: string) => Promise<AppConfig>
  savePreset: (preset: UploadPreset) => Promise<AppConfig>
  deletePreset: (id: string) => Promise<AppConfig>
  saveCategory: (category: PathCategory) => Promise<AppConfig>
  deleteCategory: (id: string) => Promise<AppConfig>
  savePreferences: (input: Pick<AppConfig, 'concurrentUploads' | 'conflictStrategy'>) => Promise<AppConfig>
  testConnection: (profile: ProfileInput) => Promise<{ ok: boolean; message: string }>
  selectFiles: () => Promise<LocalUploadItem[]>
  /** 监听主进程转发的文件拖放事件，返回取消订阅函数；回调参数为拖入的本地路径数组（含文件夹） */
  /** 把拖放的 File 对象转成真实本地路径（Electron 32+ 用 webUtils.getPathForFile，只能在预加载层调用） */
  getPathsForFiles: (files: File[]) => string[]
  pickFolderRoot: () => Promise<string | null>
  getFolderTree: (root: string) => Promise<FolderTreeNode>
  collectFolderSelection: (root: string, selectedRelativePaths: string[]) => Promise<LocalUploadItem[]>
  selectFolderForUpload: () => Promise<LocalUploadItem[]>
  /** 把拖入的本地文件/文件夹路径展开为上传项（文件→单条，文件夹→保留文件夹名为顶层目录递归展开） */
  collectFromPaths: (paths: string[]) => Promise<LocalUploadItem[]>
  upload: (request: UploadRequest) => Promise<{ skipped?: boolean }>
  cancelAllUploads: () => Promise<{ cancelled: number }>
  setObjectOperationActive: (active: boolean) => Promise<void>
  cancelObjectOperation: () => Promise<{ cancelled: boolean }>
  listObjects: (request: ListObjectsRequest) => Promise<OssObjectItem[]>
  listObjectsPage: (request: ListObjectsPageRequest) => Promise<ListObjectsPage>
  listBuckets: (profileId: string) => Promise<OssBucketItem[]>
  createFolder: (request: CreateFolderRequest) => Promise<{ key: string }>
  downloadObjects: (request: DownloadObjectsRequest) => Promise<{ directory: string; count: number; failed: number; skipped: number; failedKeys: string[]; folderCount: number } | { cancelled: true }>
  deleteObjects: (request: DeleteObjectsRequest) => Promise<{ deleted: number; failed: number; failedKeys: string[] }>
  renameObject: (request: RenameObjectRequest) => Promise<{ key: string; failed: number; skipped: number; failedKeys: string[] }>
  transferObjects: (request: TransferObjectsRequest) => Promise<{ count: number; failed: number; skipped: number; failedKeys: string[] }>
  getObjectUrl: (request: GetObjectUrlRequest) => Promise<{ signed: string; publicUrl: string }>
  previewObject: (request: PreviewObjectRequest) => Promise<ObjectPreview>
  saveObject: (request: SaveObjectRequest) => Promise<SaveObjectResult>
  copyText: (text: string) => Promise<void>
  onUploadProgress: (callback: (event: UploadProgressEvent) => void) => () => void
  onOpProgress: (callback: (event: OpProgressEvent) => void) => () => void
}
