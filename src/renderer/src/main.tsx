import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import type { AppConfig, FolderTreeNode } from '../../shared/types'

// The browser preview uses a harmless local adapter; Electron replaces this with the secure preload API.
if (!window.desktopApi) {
  const demoProfile = { id: 'demo-profile', name: '演示环境', endpoint: 'oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', accessKeyId: 'preview-only', hasSecret: true, isDefault: true }
  const backupProfile = { id: 'backup-profile', name: '备份账号', endpoint: 'oss-cn-shanghai.aliyuncs.com', region: 'oss-cn-shanghai', accessKeyId: 'preview-only', hasSecret: true, isDefault: false }
  const demoPreset = { id: 'demo-preset', name: '产品发布包', description: '桌面客户端正式版本发布', profileId: demoProfile.id, bucket: 'demo-bucket', prefix: 'releases/desktop', isDefault: true }
  const testPreset = { id: 'test-preset', name: '测试构建', description: '内测人员下载使用', profileId: demoProfile.id, bucket: 'demo-bucket', prefix: 'releases/beta', isDefault: false }
  const backupPreset = { id: 'backup-preset', name: '异地备份', description: '上海节点灾备副本', profileId: backupProfile.id, bucket: 'backup-bucket', prefix: 'archive/desktop', isDefault: false }
  let previewConfig: AppConfig = { profiles: [demoProfile, backupProfile], presets: [demoPreset, testPreset, backupPreset], concurrentUploads: 3, conflictStrategy: 'overwrite' }
  let previewFailureInjected = false
  window.desktopApi = {
    getConfig: async () => previewConfig,
    saveProfile: async (profile) => { previewConfig = { ...previewConfig, profiles: [...previewConfig.profiles.filter((item) => item.id !== profile.id), { ...profile, hasSecret: true }] }; return previewConfig },
    deleteProfile: async (id) => { previewConfig = { ...previewConfig, profiles: previewConfig.profiles.filter((item) => item.id !== id) }; return previewConfig },
    savePreset: async (preset) => { previewConfig = { ...previewConfig, presets: [...previewConfig.presets.filter((item) => item.id !== preset.id), preset] }; return previewConfig },
    deletePreset: async (id) => { previewConfig = { ...previewConfig, presets: previewConfig.presets.filter((item) => item.id !== id) }; return previewConfig },
    savePreferences: async (input) => { previewConfig = { ...previewConfig, ...input }; return previewConfig },
    testConnection: async () => ({ ok: true, message: '演示模式：连接测试通过' }),
    selectFiles: async () => Array.from({ length: 12 }, (_, index) => ({ id: crypto.randomUUID(), absolutePath: `C:/preview/package-${index + 1}.zip`, relativePath: `release/package-${index + 1}.zip`, name: `package-${index + 1}.zip`, size: (index + 1) * 1024 * 1024 })),
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
    upload: async () => { if (!previewFailureInjected) { previewFailureInjected = true; throw new Error('Preview network interruption') } return {} }, cancelAllUploads: async () => ({ cancelled: 0 }), listObjects: async ({ prefix }) => [{ key: `${prefix ? `${prefix}/` : ''}packages`, name: 'packages', size: 0, isFolder: true }, { key: `${prefix ? `${prefix}/` : ''}README.md`, name: 'README.md', size: 12345, lastModified: new Date().toISOString(), isFolder: false }], listBuckets: async () => [{ name: 'demo-bucket', region: 'oss-cn-hangzhou', creationDate: new Date().toISOString() }, { name: 'archive-bucket', region: 'oss-cn-shanghai', creationDate: new Date().toISOString() }], downloadObjects: async () => ({ directory: 'C:/Downloads', count: 1, folderCount: 0 }), copyText: async () => {}, onUploadProgress: () => () => {}
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
