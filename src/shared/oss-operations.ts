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
