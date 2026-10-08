import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopApi, OpProgressEvent, UploadProgressEvent } from '../shared/types'
import { appendOssTroubleshootingHint } from '../shared/oss-operations'

function invokeOss<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(appendOssTroubleshootingHint(message))
  })
}

const api: DesktopApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveProfile: (profile) => ipcRenderer.invoke('config:save-profile', profile),
  deleteProfile: (id) => ipcRenderer.invoke('config:delete-profile', id),
  savePreset: (preset) => ipcRenderer.invoke('config:save-preset', preset),
  deletePreset: (id) => ipcRenderer.invoke('config:delete-preset', id),
  saveCategory: (category) => ipcRenderer.invoke('config:save-category', category),
  deleteCategory: (id) => ipcRenderer.invoke('config:delete-category', id),
  savePreferences: (input) => ipcRenderer.invoke('config:save-preferences', input),
  testConnection: async (profile) => {
    const result = await invokeOss<Awaited<ReturnType<DesktopApi['testConnection']>>>('oss:test', profile)
    return result.ok ? result : { ...result, message: appendOssTroubleshootingHint(result.message) }
  },
  selectFiles: () => ipcRenderer.invoke('files:select'),
  // Electron 32+ 已移除 File.path，且在 contextIsolation 下渲染进程读不到本地路径。
  // webUtils.getPathForFile 只能在预加载（隔离上下文）里调用，因此在这里把 File 转成真实路径。
  getPathsForFiles: (files) => files
    .map((file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    })
    .filter((value): value is string => Boolean(value)),
  pickFolderRoot: () => ipcRenderer.invoke('folder:pick-root'),
  getFolderTree: (root) => ipcRenderer.invoke('folder:tree', root),
  collectFolderSelection: (root, selectedPaths) => ipcRenderer.invoke('folder:collect', root, selectedPaths),
  selectFolderForUpload: () => ipcRenderer.invoke('folder:select-upload'),
  collectFromPaths: (paths) => ipcRenderer.invoke('files:collect-from-paths', paths),
  upload: (request) => invokeOss('oss:upload', request),
  cancelAllUploads: () => ipcRenderer.invoke('oss:cancel-all'),
  setObjectOperationActive: (active) => ipcRenderer.invoke('oss:set-operation-active', active),
  cancelObjectOperation: () => ipcRenderer.invoke('oss:cancel-operation'),
  listObjects: (request) => invokeOss('oss:list-objects', request),
  listObjectsPage: (request) => invokeOss('oss:list-objects-page', request),
  listBuckets: (profileId) => invokeOss('oss:list-buckets', profileId),
  createFolder: (request) => invokeOss('oss:create-folder', request),
  downloadObjects: (request) => invokeOss('oss:download-objects', request),
  deleteObjects: (request) => invokeOss('oss:delete-objects', request),
  renameObject: (request) => invokeOss('oss:rename-object', request),
  transferObjects: (request) => invokeOss('oss:transfer-objects', request),
  getObjectUrl: (request) => invokeOss('oss:get-object-url', request),
  previewObject: (request) => invokeOss('oss:preview-object', request),
  saveObject: (request) => invokeOss('oss:save-object', request),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onUploadProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: UploadProgressEvent) => callback(value)
    ipcRenderer.on('oss:upload-progress', listener)
    return () => ipcRenderer.removeListener('oss:upload-progress', listener)
  },
  onOpProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: OpProgressEvent) => callback(value)
    ipcRenderer.on('oss:op-progress', listener)
    return () => ipcRenderer.removeListener('oss:op-progress', listener)
  }
}

contextBridge.exposeInMainWorld('desktopApi', api)
