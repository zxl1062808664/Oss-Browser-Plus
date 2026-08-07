import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import type { AppConfig } from '../../shared/types'

// The browser preview uses a harmless local adapter; Electron replaces this with the secure preload API.
if (!window.desktopApi) {
  const demoProfile = { id: 'demo-profile', name: '演示环境', endpoint: 'oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', accessKeyId: 'preview-only', hasSecret: true, isDefault: true }
  const demoPreset = { id: 'demo-preset', name: '产品发布包', profileId: demoProfile.id, bucket: 'demo-bucket', prefix: 'releases/desktop', isDefault: true }
  let previewConfig: AppConfig = { profiles: [demoProfile], presets: [demoPreset], concurrentUploads: 3, conflictStrategy: 'overwrite' }
  window.desktopApi = {
    getConfig: async () => previewConfig,
    saveProfile: async (profile) => { previewConfig = { ...previewConfig, profiles: [...previewConfig.profiles.filter((item) => item.id !== profile.id), { ...profile, hasSecret: true }] }; return previewConfig },
    deleteProfile: async (id) => { previewConfig = { ...previewConfig, profiles: previewConfig.profiles.filter((item) => item.id !== id) }; return previewConfig },
    savePreset: async (preset) => { previewConfig = { ...previewConfig, presets: [...previewConfig.presets.filter((item) => item.id !== preset.id), preset] }; return previewConfig },
    deletePreset: async (id) => { previewConfig = { ...previewConfig, presets: previewConfig.presets.filter((item) => item.id !== id) }; return previewConfig },
    savePreferences: async (input) => { previewConfig = { ...previewConfig, ...input }; return previewConfig },
    testConnection: async () => ({ ok: true, message: '演示模式：连接测试通过' }),
    selectFiles: async () => [], selectFolder: async () => [], upload: async () => ({}), copyText: async () => {}, onUploadProgress: () => () => {}
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
