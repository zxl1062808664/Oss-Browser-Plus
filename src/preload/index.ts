import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, UploadProgressEvent } from '../shared/types'

const api: DesktopApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveProfile: (profile) => ipcRenderer.invoke('config:save-profile', profile),
  deleteProfile: (id) => ipcRenderer.invoke('config:delete-profile', id),
  savePreset: (preset) => ipcRenderer.invoke('config:save-preset', preset),
  deletePreset: (id) => ipcRenderer.invoke('config:delete-preset', id),
  savePreferences: (input) => ipcRenderer.invoke('config:save-preferences', input),
  testConnection: (profile) => ipcRenderer.invoke('oss:test', profile),
  selectFiles: () => ipcRenderer.invoke('files:select'),
  selectFolder: () => ipcRenderer.invoke('folder:select'),
  upload: (request) => ipcRenderer.invoke('oss:upload', request),
  cancelAllUploads: () => ipcRenderer.invoke('oss:cancel-all'),
  listObjects: (request) => ipcRenderer.invoke('oss:list-objects', request),
  listBuckets: (profileId) => ipcRenderer.invoke('oss:list-buckets', profileId),
  downloadObjects: (request) => ipcRenderer.invoke('oss:download-objects', request),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onUploadProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: UploadProgressEvent) => callback(value)
    ipcRenderer.on('oss:upload-progress', listener)
    return () => ipcRenderer.removeListener('oss:upload-progress', listener)
  }
}

contextBridge.exposeInMainWorld('desktopApi', api)
