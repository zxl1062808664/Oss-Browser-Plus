import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import type { AppConfig, FolderTreeNode } from '../../shared/types'

// The browser preview uses a harmless local adapter; Electron replaces this with the secure preload API.
if (!window.desktopApi) {
  const demoProfile = { id: 'demo-profile', name: '演示环境', endpoint: 'oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', accessKeyId: 'preview-only', hasSecret: true, isDefault: true }
  const backupProfile = { id: 'backup-profile', name: '备份账号', endpoint: 'oss-cn-shanghai.aliyuncs.com', region: 'oss-cn-shanghai', accessKeyId: 'preview-only', hasSecret: true, isDefault: false }
  const demoPreset = { id: 'demo-preset', name: '产品发布包', description: '桌面客户端正式版本发布', profileId: demoProfile.id, bucket: 'demo-bucket', prefix: 'releases/desktop', isDefault: true, categoryId: 'cat-release' }
  const testPreset = { id: 'test-preset', name: '测试构建', description: '内测人员下载使用', profileId: demoProfile.id, bucket: 'demo-bucket', prefix: 'releases/beta', isDefault: false }
  const backupPreset = { id: 'backup-preset', name: '异地备份', description: '上海节点灾备副本', profileId: backupProfile.id, bucket: 'backup-bucket', prefix: 'archive/desktop', isDefault: false }
  let previewConfig: AppConfig = { profiles: [demoProfile, backupProfile], presets: [demoPreset, testPreset, backupPreset], categories: [{ id: 'cat-release', name: '正式发布' }], concurrentUploads: 3, conflictStrategy: 'overwrite' }
  let previewFailureInjected = false
  window.desktopApi = {
    getConfig: async () => previewConfig,
    saveProfile: async (profile) => { previewConfig = { ...previewConfig, profiles: [...previewConfig.profiles.filter((item) => item.id !== profile.id), { ...profile, hasSecret: true }] }; return previewConfig },
    deleteProfile: async (id) => { previewConfig = { ...previewConfig, profiles: previewConfig.profiles.filter((item) => item.id !== id) }; return previewConfig },
    savePreset: async (preset) => { previewConfig = { ...previewConfig, presets: [...previewConfig.presets.filter((item) => item.id !== preset.id), preset] }; return previewConfig },
    deletePreset: async (id) => { previewConfig = { ...previewConfig, presets: previewConfig.presets.filter((item) => item.id !== id) }; return previewConfig },
    saveCategory: async (category) => { previewConfig = { ...previewConfig, categories: [...previewConfig.categories.filter((item) => item.id !== category.id), category] }; return previewConfig },
    deleteCategory: async (id) => { previewConfig = { ...previewConfig, categories: previewConfig.categories.filter((item) => item.id !== id), presets: previewConfig.presets.map((preset) => preset.categoryId === id ? { ...preset, categoryId: undefined } : preset) }; return previewConfig },
    savePreferences: async (input) => { previewConfig = { ...previewConfig, ...input }; return previewConfig },
    testConnection: async () => ({ ok: true, message: '演示模式：连接测试通过' }),
    selectFiles: async () => Array.from({ length: 12 }, (_, index) => ({ id: crypto.randomUUID(), absolutePath: `C:/preview/package-${index + 1}.zip`, relativePath: `release/package-${index + 1}.zip`, name: `package-${index + 1}.zip`, size: (index + 1) * 1024 * 1024 })),
    getPathsForFiles: (files) => files.map((file) => (file as unknown as { name: string }).name),
    pickFolderRoot: async () => 'C:/projects/demo',
    getFolderTree: async (): Promise<FolderTreeNode> => ({
      name: 'demo',
      relativePath: '',
      absolutePath: 'C:/projects/demo',
      isFolder: true,
      size: 123456,
      fileCount: 4,
      children: [
        { name: 'v1.0', relativePath: 'v1.0', absolutePath: 'C:/projects/demo/v1.0', isFolder: true, size: 60000, fileCount: 2, children: [
          { name: 'app-1.0.zip', relativePath: 'v1.0/app-1.0.zip', absolutePath: 'C:/projects/demo/v1.0/app-1.0.zip', isFolder: false, size: 40000, fileCount: 0, children: [] },
          { name: 'README.md', relativePath: 'v1.0/README.md', absolutePath: 'C:/projects/demo/v1.0/README.md', isFolder: false, size: 1234, fileCount: 0, children: [] }
        ] },
        { name: 'v1.1', relativePath: 'v1.1', absolutePath: 'C:/projects/demo/v1.1', isFolder: true, size: 63456, fileCount: 2, children: [
          { name: 'app-1.1.zip', relativePath: 'v1.1/app-1.1.zip', absolutePath: 'C:/projects/demo/v1.1/app-1.1.zip', isFolder: false, size: 50000, fileCount: 0, children: [] },
          { name: 'build', relativePath: 'v1.1/build', absolutePath: 'C:/projects/demo/v1.1/build', isFolder: true, size: 13456, fileCount: 1, children: [
            { name: 'debug.log', relativePath: 'v1.1/build/debug.log', absolutePath: 'C:/projects/demo/v1.1/build/debug.log', isFolder: false, size: 13456, fileCount: 0, children: [] }
          ] }
        ] }
      ]
    }),
    collectFolderSelection: async (_root, selectedPaths) => selectedPaths.flatMap((relativePath) => [{ id: crypto.randomUUID(), absolutePath: `C:/projects/demo/${relativePath}/sample.zip`, relativePath: `${relativePath}/sample.zip`, name: 'sample.zip', size: 1024 * 1024 }]),
    selectFolderForUpload: async () => [{ id: crypto.randomUUID(), absolutePath: 'C:/upload/demo/folder/a.txt', relativePath: 'folder/a.txt', name: 'a.txt', size: 1024 }],
    collectFromPaths: async (paths) => paths.map((absolutePath) => ({ id: crypto.randomUUID(), absolutePath, relativePath: absolutePath.split('/').pop() || absolutePath, name: absolutePath.split('/').pop() || absolutePath, size: 1024 * 1024 })),
    upload: async () => { if (!previewFailureInjected) { previewFailureInjected = true; throw new Error('Preview network interruption') } return {} }, cancelAllUploads: async () => ({ cancelled: 0 }), setObjectOperationActive: async () => {}, cancelObjectOperation: async () => ({ cancelled: true }), listObjects: async ({ prefix }) => [{ key: `${prefix ? `${prefix}/` : ''}packages`, name: 'packages', size: 0, isFolder: true }, { key: `${prefix ? `${prefix}/` : ''}README.md`, name: 'README.md', size: 12345, lastModified: new Date().toISOString(), isFolder: false }], listObjectsPage: async ({ prefix }) => ({ items: [{ key: `${prefix ? `${prefix}/` : ''}packages/`, name: 'packages', size: 0, isFolder: true }, { key: `${prefix ? `${prefix}/` : ''}README.md`, name: 'README.md', size: 12345, lastModified: new Date().toISOString(), isFolder: false }] }), listBuckets: async () => [{ name: 'demo-bucket', region: 'oss-cn-hangzhou', creationDate: new Date().toISOString() }, { name: 'archive-bucket', region: 'oss-cn-shanghai', creationDate: new Date().toISOString() }], createFolder: async ({ prefix, name }) => ({ key: `${prefix ? `${prefix}/` : ''}${name}/` }), downloadObjects: async () => ({ directory: 'C:/Downloads', count: 1, failed: 0, skipped: 0, failedKeys: [], folderCount: 0 }), deleteObjects: async ({ keys }) => ({ deleted: keys.length, failed: 0, failedKeys: [] }), renameObject: async ({ key, newName }) => ({ key: key.split('/').slice(0, -1).concat(newName).join('/'), failed: 0, skipped: 0, failedKeys: [] }), transferObjects: async ({ sourceKeys }) => ({ count: sourceKeys.length, failed: 0, skipped: 0, failedKeys: [] }), getObjectUrl: async ({ key }) => ({ signed: `https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/${encodeURIComponent(key)}?signature=preview`, publicUrl: `https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/${encodeURIComponent(key)}` }), previewObject: async ({ key }) => key.toLowerCase().endsWith('.txt') ? { kind: 'text' as const, content: '预览模式：这是演示用的文本内容。\n'.repeat(20), etag: 'preview-etag', size: 620 } : { kind: 'image' as const, mimeType: 'image/svg+xml', base64: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" rx="6" fill="#1769e0"/><text x="60" y="36" fill="#fff" font-size="14" text-anchor="middle" font-family="Arial">Preview</text></svg>') }, saveObject: async ({ content }) => ({ etag: `preview-etag-${Date.now()}`, size: new TextEncoder().encode(content).length }), copyText: async () => {}, onUploadProgress: () => () => {}, onOpProgress: () => () => {}
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
