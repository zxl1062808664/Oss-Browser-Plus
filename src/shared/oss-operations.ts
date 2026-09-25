export interface ObjectTransferPair {
  source: string
  target: string
}

export function normalizeObjectPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, '')
}

export function validateObjectEntryName(value: string, label = '名称'): string {
  const name = value.trim()
  if (!name) throw new Error(`${label}不能为空`)
  if (/[\\/]/.test(name)) throw new Error(`${label}不能包含 / 或 \\`)
  if (name === '.' || name === '..') throw new Error(`${label}不能为 . 或 ..`)
  return name
}

export function buildFolderKey(prefix: string, nameInput: string): string {
  const name = validateObjectEntryName(nameInput, '文件夹名称')
  const normalizedPrefix = normalizeObjectPrefix(prefix)
  return `${normalizedPrefix ? `${normalizedPrefix}/` : ''}${name}/`
}

export function buildRenameDestination(sourceKey: string, nameInput: string): string {
  const newName = validateObjectEntryName(nameInput, '新名称')
  const isFolder = sourceKey.endsWith('/')
  const sourceWithoutSlash = isFolder ? sourceKey.slice(0, -1) : sourceKey
  const parent = sourceWithoutSlash.includes('/')
    ? sourceWithoutSlash.slice(0, sourceWithoutSlash.lastIndexOf('/') + 1)
    : ''
  const destination = `${parent}${newName}${isFolder ? '/' : ''}`
  if (destination === sourceKey) throw new Error('新名称与原名称相同')
  return destination
}

export function buildRenameObjectTarget(sourceKey: string, destinationKey: string, objectKey: string): string {
  if (!sourceKey.endsWith('/')) return destinationKey
  if (!objectKey.startsWith(sourceKey)) throw new Error(`对象不属于待重命名文件夹：${objectKey}`)
  const relative = objectKey.slice(sourceKey.length)
  return relative ? `${destinationKey}${relative}` : destinationKey
}

export function buildTransferPairs(sourceKey: string, objectKeys: string[], destinationPrefixInput: string): ObjectTransferPair[] {
  const destinationPrefix = normalizeObjectPrefix(destinationPrefixInput)
  if (!sourceKey.endsWith('/')) {
    const name = sourceKey.split('/').pop() || ''
    const target = [destinationPrefix, name].filter(Boolean).join('/')
    if (target === sourceKey) throw new Error(`目标位置与原位置相同：${sourceKey}`)
    return [{ source: sourceKey, target }]
  }

  const sourcePrefix = sourceKey.slice(0, -1)
  if (destinationPrefix === sourcePrefix || destinationPrefix.startsWith(sourceKey)) {
    throw new Error(`不能把文件夹复制或移动到自身内部：${sourceKey}`)
  }

  const folderName = sourcePrefix.split('/').pop() || ''
  const destinationFolder = [destinationPrefix, folderName].filter(Boolean).join('/')
  return objectKeys.map((objectKey) => {
    if (!objectKey.startsWith(sourceKey)) throw new Error(`对象不属于待处理文件夹：${objectKey}`)
    const relative = objectKey.slice(sourceKey.length)
    const target = relative ? `${destinationFolder}/${relative}` : `${destinationFolder}/`
    if (target === objectKey) throw new Error(`目标位置与原位置相同：${objectKey}`)
    return { source: objectKey, target }
  })
}

/** 支持双击预览的扩展名分类（主进程据此限制读取，渲染层据此决定双击是预览还是提示不支持） */
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'csv', 'tsv',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue',
  'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sh', 'bat', 'cmd', 'ps1',
  'sql', 'ini', 'cfg', 'conf', 'config', 'properties', 'toml', 'env', 'plist', 'diff', 'patch',
  'gitignore', 'dockerfile', 'lock'
])
const IMAGE_PREVIEW_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

export type ObjectPreviewKind = 'text' | 'image'

/** 按文件名（或对象 key）的扩展名判断预览类型；不支持预览时返回 null */
export function classifyObjectPreview(name: string): ObjectPreviewKind | null {
  const base = name.split('/').pop() || name
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) return 'image'
  return null
}

/** 可在应用内直接编辑保存的字节上限：超过则只读预览，提示下载后编辑 */
export const TEXT_EDIT_LIMIT = 500 * 1024

/**
 * 是否允许在应用内编辑该对象：仅文本分类，且不超过编辑上限。
 * size 未知（未取到 Content-Length）时按不可编辑处理，避免误开大文件。
 */
export function isTextEditable(name: string, size?: number): boolean {
  if (classifyObjectPreview(name) !== 'text') return false
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return false
  return size <= TEXT_EDIT_LIMIT
}

/** 超过编辑上限的提示文案，渲染层与主进程共用 */
export function textEditLimitMessage(size: number): string {
  return `文件大小 ${formatKilobytes(size)}，超过在线编辑上限 500 KB，请下载后编辑`
}

function formatKilobytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

/**
 * 校验待保存的文本内容：拒绝超限与二进制内容。
 * 保存前必须再校验一次，不能只依赖渲染层的按钮状态。
 */
export function assertSavableTextContent(content: string): void {
  if (content.includes('\u0000')) throw new Error('内容包含二进制字符，无法保存为文本')
  const bytes = utf8ByteLength(content)
  if (bytes > TEXT_EDIT_LIMIT) {
    throw new Error(`内容大小 ${formatKilobytes(bytes)}，超过在线编辑上限 500 KB，请下载后编辑`)
  }
}

/**
 * 计算 UTF-8 字节数。
 * 该模块同时被打进渲染进程，不能依赖 Node Buffer，因此按码点自行换算。
 */
export function utf8ByteLength(content: string): number {
  let bytes = 0
  for (const char of content) {
    const code = char.codePointAt(0) as number
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

export type LineEnding = '\r\n' | '\n'

/**
 * 探测文本行尾风格：出现 CRLF 即视为 CRLF 文件。
 * 保存时按原风格回写，避免一次保存把整个文件的行尾全改掉产生大 diff。
 */
export function detectLineEnding(content: string): LineEnding {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

/** 把任意行尾统一为目标风格（先把 CRLF 归一为 LF，再整体替换） */
export function normalizeLineEnding(content: string, eol: LineEnding): string {
  const unified = content.replace(/\r\n/g, '\n')
  return eol === '\n' ? unified : unified.replace(/\n/g, '\r\n')
}
