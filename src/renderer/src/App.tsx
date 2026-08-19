import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Check, ChevronDown, ChevronRight, CircleStop, Clipboard, Cloud, Copy, Download, FileUp, FileText, FolderInput, FolderOpen, FolderSearch, Gauge, HardDriveUpload,
  Link2, ListChecks, ListPlus, LoaderCircle, MapPin, Pencil, Plus, RefreshCw, ScrollText, Settings, Trash2, Upload, X
} from 'lucide-react'
import type { AppConfig, FolderTreeNode, LocalUploadItem, OssBucketItem, OssObjectItem, OssProfile, ProfileInput, UploadPreset } from '../../shared/types'

type Page = 'upload' | 'browse' | 'settings'
type TaskStatus = 'waiting' | 'uploading' | 'success' | 'failed' | 'skipped' | 'cancelled'
type UploadTask = LocalUploadItem & { status: TaskStatus; progress: number; error?: string; objectName?: string; targetPresetId?: string }
type LogEntry = { id: string; time: string; level: 'info' | 'success' | 'error'; message: string }

const emptyConfig: AppConfig = { profiles: [], presets: [], categories: [], concurrentUploads: 3, conflictStrategy: 'overwrite' }
const uid = () => crypto.randomUUID()
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
const normalizePrefix = (prefix: string) => prefix.replace(/^\/+|\/+$/g, '')
const fullPath = (preset?: UploadPreset) => preset ? `oss://${preset.bucket}/${normalizePrefix(preset.prefix)}${preset.prefix ? '/' : ''}` : ''

function App() {
  const [page, setPage] = useState<Page>('upload')
  const [config, setConfig] = useState<AppConfig>(emptyConfig)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([])
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [folderPicker, setFolderPicker] = useState<{ root: string; tree: FolderTreeNode } | null>(null)
  const [folderScanning, setFolderScanning] = useState(false)
  const [subfolder, setSubfolder] = useState('')
  const [confirmUploadOpen, setConfirmUploadOpen] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<{ onlyTaskId?: string } | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const cancelRequested = useRef(false)
  const subfolderPrefix = normalizePrefix(subfolder)

  const selectedProfile = config.profiles.find((item) => item.id === selectedProfileId)
  const availablePresets = useMemo(() => config.presets.filter((item) => item.profileId === selectedProfileId), [config.presets, selectedProfileId])
  const selectedPreset = availablePresets.find((item) => item.id === selectedPresetId)
  const selectedTargets = config.presets.filter((item) => selectedTargetIds.includes(item.id))
  const completed = tasks.filter((task) => ['success', 'skipped'].includes(task.status)).length
  const failed = tasks.filter((task) => task.status === 'failed').length
  const totalSize = tasks.reduce((sum, task) => sum + task.size, 0)
  const totalProgress = totalSize ? Math.round(tasks.reduce((sum, task) => sum + task.size * task.progress / 100, 0) / totalSize * 100) : 0

  useEffect(() => {
    window.desktopApi.getConfig().then((next) => {
      setConfig(next)
      const profileId = next.profiles.find((item) => item.isDefault)?.id || next.profiles[0]?.id || ''
      const profilePresets = next.presets.filter((item) => item.profileId === profileId)
      const presetId = profilePresets.find((item) => item.isDefault)?.id || profilePresets[0]?.id || ''
      setSelectedProfileId(profileId)
      setSelectedPresetId(presetId)
      setSelectedTargetIds(presetId ? [presetId] : [])
    })
    return window.desktopApi.onUploadProgress((event) => {
      setTasks((current) => current.map((task) => task.id === event.taskId ? { ...task, progress: event.percent } : task))
    })
  }, [])

  const notify = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 1800)
  }

  const addLog = (level: LogEntry['level'], message: string) => {
    setLogs((current) => [{ id: uid(), time: now(), level, message }, ...current].slice(0, 200))
  }

  const addItems = (items: LocalUploadItem[]) => {
    if (!items.length) return
    setTasks((current) => [...current, ...items.map((item): UploadTask => ({ ...item, status: 'waiting', progress: 0 }))])
    addLog('info', `已添加 ${items.length} 个文件到上传队列`)
  }

  const selectFiles = async () => addItems(await window.desktopApi.selectFiles())

  const selectFolder = async () => {
    const root = await window.desktopApi.pickFolderRoot()
    if (!root) return
    setFolderScanning(true)
    try {
      const tree = await window.desktopApi.getFolderTree(root)
      setFolderPicker({ root, tree })
    } catch (error) {
      notify(error instanceof Error ? error.message : '读取文件夹失败')
    } finally {
      setFolderScanning(false)
    }
  }

  const confirmFolderSelection = async (selectedPaths: string[]) => {
    if (!folderPicker) return
    try {
      const items = await window.desktopApi.collectFolderSelection(folderPicker.root, selectedPaths)
      addItems(items)
      setFolderPicker(null)
    } catch (error) {
      notify(error instanceof Error ? error.message : '收集选中文件失败')
    }
  }

  const startUpload = async (onlyTaskId?: string) => {
    if (!selectedTargets.length) return notify('请至少选择一个上传目标')
    const hasPending = tasks.some((task) => (task.status === 'waiting' || task.status === 'failed') && (!onlyTaskId || task.id === onlyTaskId))
    if (!hasPending) return notify('没有待上传文件')
    if (subfolderPrefix) {
      setPendingUpload(onlyTaskId ? { onlyTaskId } : null)
      setConfirmUploadOpen(true)
      return
    }
    await runUpload(onlyTaskId)
  }

  const runUpload = async (onlyTaskId?: string) => {
    const pending = tasks.filter((task) => (task.status === 'waiting' || task.status === 'failed') && (!onlyTaskId || task.id === onlyTaskId))
    if (!pending.length) return notify('没有待上传文件')
    const operations = pending.flatMap((task): UploadTask[] => task.targetPresetId
      ? [task]
      : selectedTargets.map((target) => ({ ...task, id: uid(), targetPresetId: target.id, status: 'waiting', progress: 0, error: undefined, objectName: undefined })))
    const replacedIds = new Set(pending.map((task) => task.id))
    setTasks((current) => [...current.filter((task) => !replacedIds.has(task.id)), ...operations])
    cancelRequested.current = false
    setBusy(true)
    const startedAt = performance.now()
    const resultCounts = { success: 0, skipped: 0, failed: 0 }
    addLog('info', `开始执行 ${operations.length} 个上传任务，共 ${selectedTargets.length} 个目标${subfolderPrefix ? `，子目录 ${subfolderPrefix}` : ''}`)
    let cursor = 0
    const worker = async () => {
      while (cursor < operations.length && !cancelRequested.current) {
        const task = operations[cursor++]
        const target = config.presets.find((preset) => preset.id === task.targetPresetId)
        if (!target) {
          resultCounts.failed += 1
          setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'failed', error: '上传路径已不存在' } : item))
          continue
        }
        const objectName = [normalizePrefix(target.prefix), subfolderPrefix, task.relativePath].filter(Boolean).join('/')
        const displayPath = `${fullPath(target)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}${task.relativePath}`
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'uploading', progress: 0, error: undefined, objectName: displayPath } : item))
        try {
          const result = await window.desktopApi.upload({
            taskId: task.id,
            absolutePath: task.absolutePath,
            objectName,
            profileId: target.profileId,
            bucket: target.bucket,
            conflictStrategy: config.conflictStrategy
          })
          const status: TaskStatus = result.skipped ? 'skipped' : 'success'
          resultCounts[result.skipped ? 'skipped' : 'success'] += 1
          setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status, progress: 100 } : item))
          addLog('success', `${result.skipped ? '已跳过' : '上传成功'}：${fullPath(target)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}${task.relativePath}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (cancelRequested.current) {
            setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'cancelled', error: undefined } : item))
          } else {
            resultCounts.failed += 1
            setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'failed', error: message } : item))
            addLog('error', `上传失败：${fullPath(target)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}${task.relativePath} · ${message}`)
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.concurrentUploads, operations.length) }, worker))
    const cancelled = operations.length - resultCounts.success - resultCounts.skipped - resultCounts.failed
    const duration = ((performance.now() - startedAt) / 1000).toFixed(1)
    const summary = `本次上传结束：共 ${operations.length} 项，成功 ${resultCounts.success}，跳过 ${resultCounts.skipped}，失败 ${resultCounts.failed}，取消 ${cancelled}，耗时 ${duration} 秒`
    addLog(resultCounts.failed ? 'error' : cancelled ? 'info' : 'success', summary)
    setBusy(false)
  }

  const cancelAll = async () => {
    const cancellable = tasks.filter((task) => task.status === 'waiting' || task.status === 'uploading')
    if (!cancellable.length) return notify('没有可取消的任务')
    cancelRequested.current = true
    const result = await window.desktopApi.cancelAllUploads()
    setTasks((current) => current.map((task) => task.status === 'waiting' || task.status === 'uploading' ? { ...task, status: 'cancelled', error: undefined } : task))
    addLog('info', `已取消全部任务：${cancellable.length} 项${result.cancelled ? `，其中 ${result.cancelled} 项正在上传` : ''}`)
    notify('所有待处理任务已取消')
  }

  const copyPath = async () => {
    if (!selectedPreset) return
    await window.desktopApi.copyText(fullPath(selectedPreset))
    notify('OSS 路径已复制')
  }

  const selectProfile = (profileId: string) => {
    const profilePresets = config.presets.filter((item) => item.profileId === profileId)
    const presetId = profilePresets.find((item) => item.isDefault)?.id || profilePresets[0]?.id || ''
    setSelectedProfileId(profileId)
    changePrimaryTarget(presetId)
  }

  const changePrimaryTarget = (presetId: string) => {
    const previousId = selectedPresetId
    setSelectedPresetId(presetId)
    setSelectedTargetIds((current) => {
      const remaining = current.filter((id) => id !== previousId && id !== presetId)
      return presetId ? [presetId, ...remaining] : remaining
    })
  }

  const applyConfig = (next: AppConfig) => {
    setConfig(next)
    const profileId = next.profiles.some((item) => item.id === selectedProfileId)
      ? selectedProfileId
      : next.profiles.find((item) => item.isDefault)?.id || next.profiles[0]?.id || ''
    const profilePresets = next.presets.filter((item) => item.profileId === profileId)
    setSelectedProfileId(profileId)
    setSelectedTargetIds((current) => current.filter((id) => next.presets.some((preset) => preset.id === id)))
    if (!profilePresets.some((item) => item.id === selectedPresetId)) {
      const presetId = profilePresets.find((item) => item.isDefault)?.id || profilePresets[0]?.id || ''
      setSelectedPresetId(presetId)
      setSelectedTargetIds((current) => presetId && !current.includes(presetId) ? [presetId, ...current] : current)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Cloud size={22} /></span><span>OSS Quick</span></div>
        <nav>
          <button className={page === 'upload' ? 'active' : ''} onClick={() => setPage('upload')}><HardDriveUpload size={19} />上传中心</button>
          <button className={page === 'browse' ? 'active' : ''} onClick={() => setPage('browse')}><FolderSearch size={19} />OSS 文件</button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings size={19} />设置</button>
        </nav>
        <div className="sidebar-status"><span className={config.profiles.length ? 'status-dot online' : 'status-dot'} />{config.profiles.length ? `${config.profiles.length} 个 OSS 连接` : '尚未配置 OSS'}</div>
      </aside>

      <main className="content">
        {page === 'upload' ? (
          <UploadPage
            config={config} tasks={tasks} selectedProfileId={selectedProfileId} selectedPresetId={selectedPresetId}
            availablePresets={availablePresets} selectedTargets={selectedTargets}
            selectedPreset={selectedPreset} selectedProfile={selectedProfile} busy={busy} folderScanning={folderScanning}
            subfolder={subfolder} onSubfolderChange={setSubfolder}
            completed={completed} failed={failed} totalSize={totalSize} totalProgress={totalProgress}
            onProfileChange={selectProfile} onPresetChange={changePrimaryTarget} onTargetsChange={setSelectedTargetIds} onCopy={copyPath} onFiles={selectFiles} onFolder={selectFolder}
            onUpload={startUpload} onSettings={() => setPage('settings')} onLogs={() => setLogOpen(true)}
            onRemove={(id) => setTasks((current) => current.filter((item) => item.id !== id))}
            onRetry={(id) => startUpload(id)}
            onClear={() => setTasks((current) => current.filter((item) => !['success', 'skipped'].includes(item.status)))}
            onCancelAll={cancelAll}
          />
        ) : page === 'browse' ? (
          <BrowsePage config={config} initialProfileId={selectedProfileId} initialPresetId={selectedPresetId} />
        ) : (
          <SettingsPage config={config} onChange={applyConfig} />
        )}
      </main>
      {folderPicker && <FolderPickerModal
        root={folderPicker.root}
        tree={folderPicker.tree}
        preset={selectedPreset}
        subfolder={subfolder}
        onClose={() => setFolderPicker(null)}
        onConfirm={confirmFolderSelection}
      />}
      {confirmUploadOpen && <Modal title="确认上传目录" wide onClose={() => setConfirmUploadOpen(false)}>
        <div className="confirm-upload">
          <p>你输入了子目录，本次队列中的文件将上传到以下文件夹：</p>
          <div className="confirm-paths">
            {selectedTargets.length ? selectedTargets.map((target) => <code key={target.id}>{`${fullPath(target)}${subfolderPrefix}/`}</code>) : <code className="empty">请先选择上传目标</code>}
          </div>
          <p className="confirm-tip">确认后本次队列的全部任务（含重试任务）都会存放到上述路径。若不想套这一层，请先清空子目录输入框再上传。</p>
          <div className="modal-actions">
            <span />
            <button type="button" className="secondary" onClick={() => setConfirmUploadOpen(false)}>返回修改</button>
            <button type="button" className="primary" onClick={() => { setConfirmUploadOpen(false); runUpload(pendingUpload?.onlyTaskId) }}><Upload size={16} />确认上传</button>
          </div>
        </div>
      </Modal>}
      {logOpen && <Modal title="运行日志" wide onClose={() => setLogOpen(false)}>
        <div className="log-viewer">
          {!logs.length ? <div className="log-empty">等待上传任务</div> : logs.map((log) => <div key={log.id} className={`log-line ${log.level}`}><time>{log.time}</time><span>{log.message}</span></div>)}
        </div>
      </Modal>}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  )
}

function BrowsePage({ config, initialProfileId, initialPresetId }: { config: AppConfig; initialProfileId: string; initialPresetId: string }) {
  const [mode, setMode] = useState<'account' | 'preset'>('preset')
  const [profileId, setProfileId] = useState(initialProfileId)
  const [presetId, setPresetId] = useState(initialPresetId)
  const [selectedBucket, setSelectedBucket] = useState('')
  const [buckets, setBuckets] = useState<OssBucketItem[]>([])
  const [currentPrefix, setCurrentPrefix] = useState('')
  const [objects, setObjects] = useState<OssObjectItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [notice, setNotice] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [busyOp, setBusyOp] = useState(false)
  const [renaming, setRenaming] = useState<OssObjectItem | null>(null)
  const [transferTarget, setTransferTarget] = useState<'copy' | 'move' | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<OssObjectItem[] | null>(null)
  const [urlItem, setUrlItem] = useState<{ key: string; signed: string; publicUrl: string } | null>(null)
  const [urlExpires, setUrlExpires] = useState(604800)
  const [uploadQueue, setUploadQueue] = useState<UploadTask[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const urlExpireOptions = [
    { label: '有效期：1 小时', value: 3600 },
    { label: '有效期：1 天', value: 86400 },
    { label: '有效期：7 天', value: 604800 }
  ]
  const profile = config.profiles.find((item) => item.id === profileId)
  const [presetCategoryId, setPresetCategoryId] = useState('')
  const accountPresets = config.presets.filter((item) => item.profileId === profileId)
  const presets = presetCategoryId ? accountPresets.filter((item) => item.categoryId === presetCategoryId) : accountPresets
  const preset = config.presets.find((item) => item.id === presetId && item.profileId === profileId)
  const rootPrefix = mode === 'preset' ? normalizePrefix(preset?.prefix || '') : ''
  const bucketName = mode === 'account' ? selectedBucket : preset?.bucket || ''
  const bucketRegion = mode === 'account' ? buckets.find((item) => item.name === selectedBucket)?.region : undefined
  const atBucketList = mode === 'account' && !selectedBucket
  const changePresetCategory = (value: string) => {
    setPresetCategoryId(value)
    const list = value ? accountPresets.filter((item) => item.categoryId === value) : accountPresets
    if (!list.some((item) => item.id === presetId) && list.length) setPresetId(list[0].id)
  }

  useEffect(() => {
    if (!profileId && config.profiles.length) setProfileId(config.profiles.find((item) => item.isDefault)?.id || config.profiles[0].id)
  }, [config.profiles, profileId])

  useEffect(() => {
    const nextPresets = config.presets.filter((item) => item.profileId === profileId)
    if (!nextPresets.some((item) => item.id === presetId)) setPresetId(nextPresets.find((item) => item.isDefault)?.id || nextPresets[0]?.id || '')
  }, [config.presets, profileId, presetId])

  useEffect(() => {
    if (mode === 'account') {
      setSelectedBucket('')
      setCurrentPrefix('')
    }
    setSelectedKeys([])
    setNotice('')
  }, [mode, profileId])

  useEffect(() => {
    setCurrentPrefix(rootPrefix)
    setSelectedKeys([])
  }, [rootPrefix, presetId])

  useEffect(() => {
    setSelectedKeys([])
  }, [currentPrefix, selectedBucket])

  useEffect(() => {
    if (!profile || (mode === 'preset' && !preset)) {
      setObjects([])
      return
    }
    let cancelled = false
    setLoading(true)
    const request = atBucketList
      ? window.desktopApi.listBuckets(profile.id).then((items) => { if (!cancelled) { setBuckets(items); setObjects([]) } })
      : window.desktopApi.listObjects({ profileId: profile.id, bucket: bucketName, prefix: currentPrefix, region: bucketRegion }).then((items) => { if (!cancelled) setObjects(items) })
    request
      .catch((error) => { if (!cancelled) setNotice(error instanceof Error ? error.message : '读取 OSS 目录失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [atBucketList, bucketName, bucketRegion, currentPrefix, mode, preset, profile, refreshKey])

  useEffect(() => window.desktopApi.onUploadProgress((event) => {
    setUploadQueue((current) => current.map((item) => item.id === event.taskId ? { ...item, progress: event.percent } : item))
  }), [])

  const copyBrowsePath = async () => {
    if (!bucketName) return
    const value = `oss://${bucketName}/${currentPrefix ? `${currentPrefix}/` : ''}`
    await window.desktopApi.copyText(value)
    setNotice('当前 OSS 路径已复制')
  }

  const downloadSelected = async () => {
    if (!profile || !bucketName || !selectedKeys.length) return
    setDownloading(true)
    setNotice('正在准备下载...')
    try {
      const selectedItems = objects.filter((item) => selectedKeys.includes(item.key))
      const result = await window.desktopApi.downloadObjects({
        profileId: profile.id,
        bucket: bucketName,
        prefix: currentPrefix,
        region: bucketRegion,
        keys: selectedItems.filter((item) => !item.isFolder).map((item) => item.key),
        folderKeys: selectedItems.filter((item) => item.isFolder).map((item) => item.key)
      })
      if ('cancelled' in result) setNotice('已取消选择下载目录')
      else setNotice(`已下载 ${result.count} 个文件${result.folderCount ? `（${result.folderCount} 个文件夹）` : ''}到 ${result.directory}`)
      setSelectedKeys([])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '下载失败')
    } finally {
      setDownloading(false)
    }
  }

  const refreshObjects = () => setRefreshKey((value) => value + 1)

  const openRename = (item: OssObjectItem) => setRenaming(item)

  const confirmRename = async (newName: string) => {
    if (!renaming || !profile || !bucketName) return
    setBusyOp(true)
    try {
      const result = await window.desktopApi.renameObject({
        profileId: profile.id, bucket: bucketName, region: bucketRegion, key: renaming.key, newName
      })
      setNotice(`已重命名为：${result.key}`)
      refreshObjects()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重命名失败')
    } finally {
      setBusyOp(false)
      setRenaming(null)
    }
  }

  const requestDelete = (items: OssObjectItem[]) => setConfirmingDelete(items)

  const confirmDelete = async () => {
    if (!confirmingDelete || !profile || !bucketName) return
    setBusyOp(true)
    try {
      const result = await window.desktopApi.deleteObjects({
        profileId: profile.id, bucket: bucketName, region: bucketRegion,
        keys: confirmingDelete.map((item) => item.key)
      })
      setNotice(`已删除 ${result.deleted} 个对象`)
      setSelectedKeys([])
      refreshObjects()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败')
    } finally {
      setBusyOp(false)
      setConfirmingDelete(null)
    }
  }

  const requestTransfer = (mode: 'copy' | 'move') => setTransferTarget(mode)

  const confirmTransfer = async (destinationPrefix: string) => {
    if (!transferTarget || !selectedKeys.length || !profile || !bucketName) return
    setBusyOp(true)
    const action = transferTarget === 'copy' ? '复制' : '移动'
    try {
      const result = await window.desktopApi.transferObjects({
        profileId: profile.id, bucket: bucketName, region: bucketRegion,
        sourceKeys: selectedKeys, destinationPrefix, mode: transferTarget
      })
      setNotice(`${action}完成：共 ${result.count} 个对象`)
      setSelectedKeys([])
      refreshObjects()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${action}失败`)
    } finally {
      setBusyOp(false)
      setTransferTarget(null)
    }
  }

  const fetchUrl = async (item: OssObjectItem) => {
    if (!profile || !bucketName) return
    setBusyOp(true)
    try {
      const result = await window.desktopApi.getObjectUrl({
        profileId: profile.id, bucket: bucketName, region: bucketRegion, key: item.key, expires: urlExpires
      })
      setUrlItem({ key: item.key, signed: result.signed, publicUrl: result.publicUrl })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '获取地址失败')
    } finally {
      setBusyOp(false)
    }
  }

  const refreshSignedUrl = async (expires: number) => {
    if (!profile || !bucketName || !urlItem) return
    setBusyOp(true)
    try {
      const result = await window.desktopApi.getObjectUrl({
        profileId: profile.id, bucket: bucketName, region: bucketRegion, key: urlItem.key, expires
      })
      setUrlExpires(expires)
      setUrlItem({ ...urlItem, signed: result.signed })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重新生成签名地址失败')
    } finally {
      setBusyOp(false)
    }
  }

  const copyUrlValue = async (value: string, label: string) => {
    await window.desktopApi.copyText(value)
    setNotice(`${label}已复制到剪贴板`)
  }

  const uploadToCurrentDir = async (items: LocalUploadItem[]) => {
    if (!profile || !bucketName || !items.length) return
    const tasks: UploadTask[] = items.map((item) => ({ ...item, status: 'waiting', progress: 0 }))
    setUploadQueue((queue) => [...queue, ...tasks])
    setUploading(true)
    let cursor = 0
    let failedCount = 0
    const worker = async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++]
        const objectName = [currentPrefix, task.relativePath.replace(/^\/+/, '')].filter(Boolean).join('/')
        setUploadQueue((queue) => queue.map((item) => item.id === task.id ? { ...item, status: 'uploading', progress: 0, objectName } : item))
        try {
          await window.desktopApi.upload({
            taskId: task.id,
            absolutePath: task.absolutePath,
            objectName,
            profileId: profile.id,
            bucket: bucketName,
            conflictStrategy: config.conflictStrategy
          })
          setUploadQueue((queue) => queue.map((item) => item.id === task.id ? { ...item, status: 'success', progress: 100 } : item))
        } catch (error) {
          failedCount += 1
          setUploadQueue((queue) => queue.map((item) => item.id === task.id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) } : item))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.concurrentUploads, tasks.length) }, worker))
    setUploading(false)
    setNotice(`上传完成：成功 ${tasks.length - failedCount} / ${tasks.length} 项 → oss://${bucketName}/${currentPrefix ? `${currentPrefix}/` : ''}`)
    refreshObjects()
  }

  const uploadFilesToDir = async () => {
    const items = await window.desktopApi.selectFiles()
    if (items.length) await uploadToCurrentDir(items)
  }

  const uploadFolderToDir = async () => {
    const items = await window.desktopApi.selectFolderForUpload()
    if (items.length) await uploadToCurrentDir(items)
  }

  const toggleItem = (key: string, checked: boolean) => setSelectedKeys((current) => checked ? [...new Set([...current, key])] : current.filter((item) => item !== key))
  const selectAll = (checked: boolean) => setSelectedKeys(checked ? objects.map((item) => item.key) : [])
  const goUp = () => {
    if (mode === 'account' && selectedBucket && !currentPrefix) {
      setSelectedBucket('')
      setSelectedKeys([])
      return
    }
    if (currentPrefix === rootPrefix) return
    const parent = currentPrefix.split('/').slice(0, -1).join('/')
    setCurrentPrefix(parent.length >= rootPrefix.length ? parent : rootPrefix)
  }

  return <>
    <header className="page-header"><div className="header-btn-wrap"><button className="icon-button" title="查看上传进度" onClick={() => setUploadOpen(true)}><Upload size={19} /></button>{uploadQueue.some((item) => item.status === 'waiting' || item.status === 'uploading') && <span className="upload-badge">{uploadQueue.filter((item) => item.status === 'waiting' || item.status === 'uploading').length}</span>}</div><button className="icon-button" title="刷新目录" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={19} /></button></header>
    <div className="browse-mode"><span>查看范围</span><div className="segmented"><button className={mode === 'account' ? 'active' : ''} onClick={() => setMode('account')}>整个账号</button><button className={mode === 'preset' ? 'active' : ''} onClick={() => setMode('preset')}>预设路径</button></div></div>
    {!config.profiles.length ? <div className="empty-setup"><span className="empty-icon"><Cloud size={30} /></span><h2>先配置 OSS 账号</h2><p>配置账号后即可查看 OSS 文件。</p></div> : mode === 'preset' && !preset ? <div className="empty-setup"><span className="empty-icon"><FolderSearch size={30} /></span><h2>暂无可查看路径</h2><p>请在设置中添加一个常用路径，或切换到整个账号模式。</p></div> : <>
      <section className={`browse-toolbar${mode === 'preset' ? ' four' : ''}`}>
        <div className="browse-field"><label htmlFor="browse-profile">OSS 账号</label><div className="select-wrap"><select id="browse-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>{config.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={16} /></div></div>
        {mode === 'preset' ? <>
          <div className="browse-field"><label htmlFor="browse-category">分类</label><div className="select-wrap"><select id="browse-category" value={presetCategoryId} onChange={(event) => changePresetCategory(event.target.value)}><option value="">全部分类</option>{config.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><ChevronDown size={16} /></div></div>
          <div className="browse-field"><label htmlFor="browse-preset">预设路径</label><div className="select-wrap"><select id="browse-preset" value={presetId} onChange={(event) => setPresetId(event.target.value)}>{presets.length ? presets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.description ? ` · ${item.description}` : ''}</option>) : <option value="">{presetCategoryId ? '该分类暂无路径' : '暂无路径'}</option>}</select><ChevronDown size={16} /></div></div>
        </> : <div className="browse-field"><label>当前 Bucket</label><div className="browse-scope-value">{selectedBucket || `全部 Bucket（${buckets.length}）`}</div></div>}
        <div className="browse-path"><span>{atBucketList ? 'oss://' : `oss://${bucketName}/${currentPrefix ? `${currentPrefix}/` : ''}`}</span><button className="icon-button small" disabled={atBucketList} title="复制当前路径" onClick={copyBrowsePath}><Clipboard size={16} /></button></div>
      </section>
      {!atBucketList && <div className="browse-upload-bar">
        <span className="browse-upload-title"><Upload size={15} />上传到 <b>{bucketName}{currentPrefix ? `/${currentPrefix}/` : '/'}</b></span>
        <button className="secondary compact" disabled={uploading} onClick={uploadFilesToDir}><FileUp size={15} />上传文件</button>
        <button className="secondary compact" disabled={uploading} onClick={uploadFolderToDir}><FolderOpen size={15} />上传文件夹</button>
      </div>}
      <section className="browse-band"><div className="breadcrumbs"><button disabled={atBucketList || (mode === 'preset' && currentPrefix === rootPrefix)} onClick={goUp}><ArrowUp size={15} />返回上级</button><span>{atBucketList ? 'Bucket 列表' : mode === 'account' ? `${selectedBucket}${currentPrefix ? ` / ${currentPrefix}` : ' / 根目录'}` : currentPrefix.slice(rootPrefix.length).replace(/^\/+/, '') || '根目录'}</span></div>{!atBucketList && <div className="browse-actions"><label className="select-all"><input type="checkbox" checked={objects.length > 0 && selectedKeys.length === objects.length} onChange={(event) => selectAll(event.target.checked)} />全选</label><button className="secondary compact" disabled={!selectedKeys.length || busyOp} onClick={() => requestTransfer('copy')}><Copy size={15} />复制到…</button><button className="secondary compact" disabled={!selectedKeys.length || busyOp} onClick={() => requestTransfer('move')}><FolderInput size={15} />移动到…</button><button className="secondary compact danger-op" disabled={!selectedKeys.length || busyOp} onClick={() => requestDelete(objects.filter((item) => selectedKeys.includes(item.key)))}><Trash2 size={15} />删除选中</button><button className="primary compact" disabled={!selectedKeys.length || downloading || busyOp} onClick={downloadSelected}>{downloading ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}下载选中项</button></div>}</section>
      {notice && <div className="browse-notice">{notice}</div>}
      <section className="object-table"><div className="object-head"><span>{atBucketList ? 'Bucket' : '名称'}</span><span>{atBucketList ? 'Region' : '大小'}</span><span>{atBucketList ? '创建时间' : '修改时间'}</span><span>操作</span></div>{loading ? <div className="object-empty"><LoaderCircle className="spin" size={25} /><span>正在读取 OSS 数据...</span></div> : atBucketList ? (!buckets.length ? <div className="object-empty"><Cloud size={25} /><span>该账号下没有可访问的 Bucket</span></div> : buckets.map((bucket) => <div className="object-row" key={bucket.name} onDoubleClick={() => { setSelectedBucket(bucket.name); setCurrentPrefix('') }}><div className="object-name"><Cloud size={19} /><span>{bucket.name}</span></div><span>{bucket.region || '—'}</span><span>{bucket.creationDate ? new Date(bucket.creationDate).toLocaleString('zh-CN') : '—'}</span><span><button className="text-button" onClick={() => { setSelectedBucket(bucket.name); setCurrentPrefix('') }}>打开</button></span></div>)) : !objects.length ? <div className="object-empty"><FolderOpen size={25} /><span>当前目录为空</span></div> : objects.map((object) => <div className="object-row" key={object.key} onDoubleClick={() => object.isFolder && setCurrentPrefix(object.key.replace(/\/+$/, ''))}><div className="object-name">{object.isFolder ? <FolderOpen size={19} /> : <FileText size={19} />}<span>{object.name}</span></div><span>{object.isFolder ? '文件夹' : formatBytes(object.size)}</span><span>{object.lastModified ? new Date(object.lastModified).toLocaleString('zh-CN') : '—'}</span><span className="object-actions">{object.isFolder ? <button className="icon-button small" title="打开文件夹" onClick={() => setCurrentPrefix(object.key.replace(/\/+$/, ''))}><FolderOpen size={15} /></button> : <button className="icon-button small" title="获取地址" disabled={busyOp} onClick={() => fetchUrl(object)}><Link2 size={15} /></button>}<button className="icon-button small" title="重命名" disabled={busyOp} onClick={() => openRename(object)}><Pencil size={15} /></button><button className="icon-button small danger" title="删除" disabled={busyOp} onClick={() => requestDelete([object])}><Trash2 size={15} /></button><input aria-label={`选择 ${object.name}`} type="checkbox" checked={selectedKeys.includes(object.key)} onChange={(event) => toggleItem(object.key, event.target.checked)} /></span></div>)}</section>
      </>}
    {renaming && <Modal title="重命名" onClose={() => !busyOp && setRenaming(null)}>
      <RenameForm item={renaming} busy={busyOp} onCancel={() => setRenaming(null)} onConfirm={confirmRename} />
    </Modal>}
    {transferTarget && <Modal title={transferTarget === 'copy' ? '复制到目录' : '移动到目录'} onClose={() => !busyOp && setTransferTarget(null)}>
      <OssFolderPicker
        profileId={profile?.id || ''}
        bucket={bucketName}
        region={bucketRegion}
        mode={transferTarget}
        items={objects.filter((item) => selectedKeys.includes(item.key))}
        busy={busyOp}
        onCancel={() => setTransferTarget(null)}
        onSelect={confirmTransfer}
      />
    </Modal>}
    {confirmingDelete && <Modal title="确认删除" onClose={() => !busyOp && setConfirmingDelete(null)}>
      <div className="op-form">
        <p className="op-warn">即将删除以下 {confirmingDelete.length} 项，此操作不可恢复：</p>
        <div className="op-target-list">{confirmingDelete.map((item) => <code key={item.key}>{item.key}{item.isFolder ? '/' : ''}</code>)}</div>
        {confirmingDelete.some((item) => item.isFolder) && <p className="op-warn">包含文件夹，其下所有对象都会被一并删除。</p>}
        <div className="op-actions"><button type="button" className="text-button" disabled={busyOp} onClick={() => setConfirmingDelete(null)}>取消</button><button className="primary danger" disabled={busyOp} onClick={confirmDelete}><Trash2 size={16} />确认删除</button></div>
      </div>
    </Modal>}
    {urlItem && <Modal title="对象地址" wide onClose={() => setUrlItem(null)}>
      <div className="op-form">
        <p className="op-tip">对象：<code>{urlItem.key}</code></p>
        <div className="url-field">
          <div className="url-field-head"><label>签名地址</label><select value={urlExpires} disabled={busyOp} onChange={(event) => refreshSignedUrl(Number(event.target.value))}>{urlExpireOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
          <div className="url-box"><code>{urlItem.signed}</code><button className="secondary compact" title="复制签名地址" onClick={() => copyUrlValue(urlItem.signed, '签名地址')}><Clipboard size={14} />复制</button></div>
        </div>
        <div className="url-field">
          <div className="url-field-head"><label>长期地址（公开访问，不过期）</label></div>
          <div className="url-box"><code>{urlItem.publicUrl}</code><button className="secondary compact" title="复制长期地址" onClick={() => copyUrlValue(urlItem.publicUrl, '长期地址')}><Clipboard size={14} />复制</button></div>
        </div>
        <p className="op-warn">签名地址到期后需在面板中重新选择有效期生成；长期地址仅当 Bucket 为公共读时可直接访问，私有 Bucket 请使用签名地址。</p>
        <div className="op-actions"><button type="button" className="text-button" onClick={() => setUrlItem(null)}>关闭</button></div>
      </div>
    </Modal>}
    {uploadOpen && <Modal title="上传进度" wide onClose={() => setUploadOpen(false)}>
      <div className="op-form">
        {!uploadQueue.length ? <div className="picker-empty">暂无上传任务</div> : <>
          <div className="browse-upload-list">{uploadQueue.map((task) => <div className="browse-upload-row" key={task.id}>
            <span className="browse-upload-name" title={task.objectName || task.relativePath}>{task.relativePath}</span>
            <div className="progress-track"><i style={{ width: `${task.progress}%` }} /></div>
            <span className={`upload-status ${task.status}`}>{task.status === 'uploading' ? `${task.progress}%` : task.status === 'success' ? '完成' : task.status === 'failed' ? '失败' : '等待'}</span>
          </div>)}</div>
          <div className="op-actions"><button type="button" className="text-button" disabled={uploading} onClick={() => setUploadQueue((queue) => queue.filter((item) => !['success', 'failed'].includes(item.status)))}>清空已完成</button><button type="button" className="primary" onClick={() => setUploadOpen(false)}>关闭</button></div>
        </>}
      </div>
    </Modal>}
  </>
}

interface UploadPageProps {
  config: AppConfig; tasks: UploadTask[]; selectedProfileId: string; selectedPresetId: string
  availablePresets: UploadPreset[]; selectedTargets: UploadPreset[]
  selectedPreset?: UploadPreset; selectedProfile?: OssProfile; busy: boolean; folderScanning: boolean
  subfolder: string; onSubfolderChange: (value: string) => void
  completed: number; failed: number; totalSize: number; totalProgress: number
  onProfileChange: (id: string) => void; onPresetChange: (id: string) => void; onTargetsChange: (ids: string[]) => void; onCopy: () => void; onFiles: () => void; onFolder: () => void
  onUpload: () => void; onSettings: () => void; onLogs: () => void; onRemove: (id: string) => void; onRetry: (id: string) => void; onClear: () => void; onCancelAll: () => void
}

function UploadPage(props: UploadPageProps) {
  const { config, tasks, selectedPreset, selectedProfile, subfolder, onSubfolderChange } = props
  const [showTargetPicker, setShowTargetPicker] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('')
  const subfolderPrefix = normalizePrefix(subfolder)
  const filteredPresets = categoryFilter ? props.availablePresets.filter((preset) => preset.categoryId === categoryFilter) : props.availablePresets
  const changeCategoryFilter = (value: string) => {
    setCategoryFilter(value)
    const list = value ? props.availablePresets.filter((preset) => preset.categoryId === value) : props.availablePresets
    if (!list.some((preset) => preset.id === props.selectedPresetId) && list.length) props.onPresetChange(list[0].id)
  }
  return <>
    <header className="page-header">
      <button className="icon-button" title="查看运行日志" onClick={props.onLogs}><ScrollText size={19} /></button>
    </header>

    {!config.profiles.length ? <div className="empty-setup">
      <span className="empty-icon"><Cloud size={30} /></span>
      <h2>先添加一个上传路径</h2><p>配置 OSS 凭据和常用目录后，就可以在这里一键上传。</p>
      <button className="primary" onClick={props.onSettings}><Settings size={17} />前往设置</button>
    </div> : <>
      <section className="target-band">
        <div className="target-selector">
          <label htmlFor="profile-target">OSS 账号</label>
          <div className="select-wrap"><select id="profile-target" disabled={props.busy} value={props.selectedProfileId} onChange={(event) => props.onProfileChange(event.target.value)}>{config.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><ChevronDown size={16} /></div>
        </div>
        <div className="target-selector">
          <label htmlFor="category-target">分类</label>
          <div className="select-wrap"><select id="category-target" disabled={props.busy || !config.categories.length} value={categoryFilter} onChange={(event) => changeCategoryFilter(event.target.value)}><option value="">全部分类</option>{config.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><ChevronDown size={16} /></div>
        </div>
        <div className="target-selector">
          <label htmlFor="path-target">上传路径</label>
          <div className="select-wrap"><select id="path-target" disabled={props.busy || !props.availablePresets.length} value={props.selectedPresetId} onChange={(event) => props.onPresetChange(event.target.value)}>{filteredPresets.length ? filteredPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.description ? ` · ${preset.description}` : ''}</option>) : <option value="">{categoryFilter ? (props.availablePresets.length ? '该分类暂无路径' : '该账号暂无上传路径') : '该账号暂无上传路径'}</option>}</select><ChevronDown size={16} /></div>
        </div>
        <div className="path-field"><label>路径预览</label><div className={`path-preview ${selectedPreset ? '' : 'empty'}`}><span>{selectedPreset ? `${fullPath(selectedPreset)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}` : '请前往设置为该账号添加路径'}</span><button className="icon-button small" disabled={!selectedPreset} title="复制 OSS 路径" onClick={props.onCopy}><Clipboard size={17} /></button></div></div>
      </section>

      <div className="subfolder-bar">
        <label htmlFor="subfolder-input" title="为空时直接放入目标路径；输入后会在目标路径下先套一层文件夹再存放选中内容">子目录（可选）</label>
        <input id="subfolder-input" disabled={props.busy || !selectedPreset} value={subfolder} placeholder="留空则直接放入目标路径；输入则先套一层文件夹，例如 release-2024" onChange={(event) => onSubfolderChange(event.target.value)} />
        {subfolderPrefix && selectedPreset && <span className="subfolder-preview">最终路径：<b>{`${fullPath(selectedPreset)}${subfolderPrefix}/`}</b>（此层级对本次队列全部任务生效）</span>}
        {!subfolderPrefix && selectedPreset && <span className="subfolder-hint">未输入子目录，选中内容将直接放入目标路径 <b>{fullPath(selectedPreset)}</b></span>}
      </div>

      <section className="target-summary">
        <div className="target-summary-title"><MapPin size={16} /><span>本次上传到 <b>{props.selectedTargets.length}</b> 个位置</span></div>
        <div className="target-chips">{props.selectedTargets.map((target) => <span className="target-chip" key={target.id} title={`${fullPath(target)}${target.description ? `\n${target.description}` : ''}`}><b>{target.name}</b>{target.description && <small>{target.description}</small>}{target.id !== props.selectedPresetId && !props.busy && <button title="移除附加目标" onClick={() => props.onTargetsChange(props.selectedTargets.filter((item) => item.id !== target.id).map((item) => item.id))}><X size={13} /></button>}</span>)}</div>
        <button className="secondary compact" disabled={props.busy || !config.presets.length} onClick={() => setShowTargetPicker(true)}><ListPlus size={15} />添加其他目标</button>
      </section>

      <section className="actions-row">
        <div className="add-actions">
          <button className="secondary" onClick={props.onFiles}><FileUp size={18} />选择文件</button>
          <button className="secondary" disabled={props.folderScanning} onClick={props.onFolder} title="选择项目根文件夹后，勾选其中要上传的版本/子文件夹">{props.folderScanning ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={18} />}{props.folderScanning ? '读取目录中...' : '选择文件夹'}</button>
        </div>
        <button className="primary upload-button" disabled={props.busy || !tasks.some((task) => task.status === 'waiting' || task.status === 'failed')} onClick={() => props.onUpload()}>
          {props.busy ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}{props.busy ? '正在上传' : '开始上传'}
        </button>
      </section>

      <section className="summary-strip">
        <div><ListChecks size={18} /><span><b>{tasks.length}</b> 个文件</span></div>
        <div><Gauge size={18} /><span><b>{formatBytes(props.totalSize)}</b> 总大小</span></div>
        <div className="summary-progress"><span>{props.completed} 已完成{props.failed ? ` · ${props.failed} 失败` : ''}</span><div className="progress-track"><i style={{ width: `${props.totalProgress}%` }} /></div><b>{props.totalProgress}%</b></div>
      </section>

      <section className="task-section">
        <div className="section-heading"><div><h2>上传队列</h2><span>{tasks.filter((task) => task.status === 'waiting').length} 项等待</span></div><div className="queue-actions"><button className="secondary compact" disabled={!tasks.some((task) => task.status === 'waiting' || task.status === 'uploading')} onClick={props.onCancelAll}><CircleStop size={15} />取消所有任务</button><button className="secondary compact" disabled={!props.completed} onClick={props.onClear}><Trash2 size={15} />清空已完成</button></div></div>
        <div className="task-table">
          <div className="task-head"><span>文件</span><span>大小</span><span>进度</span><span>状态</span><span /></div>
          {!tasks.length ? <div className="queue-empty"><HardDriveUpload size={28} /><span>上传队列为空</span><small>选择文件或文件夹以添加任务</small></div> : tasks.map((task) => <TaskRow key={task.id} task={task} busy={props.busy} onRetry={() => props.onRetry(task.id)} onRemove={() => props.onRemove(task.id)} />)}
        </div>
      </section>
    </>}
    {showTargetPicker && <TargetPickerModal config={config} primaryId={props.selectedPresetId} selectedIds={props.selectedTargets.map((target) => target.id)} onClose={() => setShowTargetPicker(false)} onSave={(ids) => { props.onTargetsChange(ids); setShowTargetPicker(false) }} />}
  </>
}

function TaskRow({ task, busy, onRetry, onRemove }: { task: UploadTask; busy: boolean; onRetry: () => void; onRemove: () => void }) {
  const labels: Record<TaskStatus, string> = { waiting: '等待中', uploading: '上传中', success: '已完成', failed: '失败', skipped: '已跳过', cancelled: '已取消' }
  return <div className="task-row">
    <div className="file-cell"><span className="file-icon"><FileUp size={17} /></span><div><strong title={task.relativePath}>{task.relativePath}</strong><small title={task.objectName}>{task.objectName || '等待分配目标路径'}</small></div></div>
    <span>{formatBytes(task.size)}</span>
    <div className="row-progress"><div className="progress-track"><i style={{ width: `${task.progress}%` }} /></div><span>{task.progress}%</span></div>
    <span className={`task-status ${task.status}`}>{task.status === 'uploading' && <LoaderCircle className="spin" size={14} />}{labels[task.status]}</span>
    <div className="task-actions">{task.status === 'failed' && <button className="icon-button small retry" title="重试此任务" disabled={busy} onClick={onRetry}><RefreshCw size={15} /></button>}<button className="icon-button small" title="移除任务" disabled={task.status === 'uploading'} onClick={onRemove}><X size={16} /></button></div>
    {task.error && <div className="task-error">{task.error}</div>}
  </div>
}

function SettingsPage({ config, onChange }: { config: AppConfig; onChange: (config: AppConfig) => void }) {
  const [tab, setTab] = useState<'oss' | 'paths' | 'categories' | 'upload'>('oss')
  const [profileForm, setProfileForm] = useState<ProfileInput | null>(null)
  const [presetForm, setPresetForm] = useState<UploadPreset | null>(null)
  const [message, setMessage] = useState('')
  const [pathProfileId, setPathProfileId] = useState(config.profiles[0]?.id || '')
  const [categoryName, setCategoryName] = useState('')
  const effectivePathProfileId = config.profiles.some((profile) => profile.id === pathProfileId) ? pathProfileId : (config.profiles[0]?.id || '')
  useEffect(() => {
    if (pathProfileId !== effectivePathProfileId) setPathProfileId(effectivePathProfileId)
  }, [pathProfileId, effectivePathProfileId])
  const accountPresets = config.presets.filter((preset) => preset.profileId === effectivePathProfileId)
  const categoryNameOf = (categoryId?: string) => config.categories.find((category) => category.id === categoryId)?.name
  const addCategory = async () => {
    if (!categoryName.trim()) return
    onChange(await window.desktopApi.saveCategory({ id: uid(), name: categoryName.trim() }))
    setCategoryName('')
  }
  const newProfile = (): ProfileInput => ({ id: uid(), name: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '', hasSecret: false, isDefault: !config.profiles.length })
  const newPreset = (): UploadPreset => ({ id: uid(), name: '', description: '', profileId: effectivePathProfileId, bucket: '', prefix: '', isDefault: !config.presets.length })

  return <>
    <div className="settings-tabs">
      <button className={tab === 'oss' ? 'active' : ''} onClick={() => setTab('oss')}>账号配置</button>
      <button className={tab === 'paths' ? 'active' : ''} onClick={() => setTab('paths')}>常用路径</button>
      <button className={tab === 'categories' ? 'active' : ''} onClick={() => setTab('categories')}>路径分类</button>
      <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>上传设置</button>
    </div>

    {tab === 'oss' && <section className="settings-section">
      <div className="section-heading"><div><h2>OSS 账号</h2><span>账号保存后，新增路径无需再次填写 AccessKey</span></div><button className="primary compact" onClick={() => { setProfileForm(newProfile()); setMessage('') }}><Plus size={17} />添加账号</button></div>
      {!config.profiles.length ? <SettingsEmpty title="还没有 OSS 账号" text="账号信息只需配置一次，之后可以添加任意数量的常用路径。" /> : <div className="config-list">{config.profiles.map((profile) => <div className="config-row" key={profile.id}>
        <span className="config-icon"><Cloud size={20} /></span><div className="config-main"><div><strong>{profile.name}</strong>{profile.isDefault && <em>默认</em>}</div><span>{profile.endpoint}</span></div>
        <span className={profile.hasSecret ? 'credential good' : 'credential'}>{profile.hasSecret ? '凭据已保存' : '缺少 Secret'}</span>
        <button className="icon-button small" title="编辑" onClick={() => { setProfileForm({ ...profile, accessKeySecret: '' }); setMessage('') }}><Pencil size={16} /></button>
        <button className="icon-button small danger" title="删除" onClick={async () => onChange(await window.desktopApi.deleteProfile(profile.id))}><Trash2 size={16} /></button>
      </div>)}</div>}
    </section>}

    {tab === 'paths' && <section className="settings-section">
      <div className="section-heading"><div><h2>常用路径</h2><span>按账号分组管理，先选择账号再显示该账号下的路径</span></div><button className="primary compact" disabled={!config.profiles.length} onClick={() => setPresetForm(newPreset())}><Plus size={17} />添加路径</button></div>
      {!config.profiles.length ? <SettingsEmpty title="还没有 OSS 账号" text="请先在“账号配置”中添加账号。" /> : <>
        <div className="path-filter">
          <label htmlFor="path-profile-filter">选择账号</label>
          <div className="select-wrap"><select id="path-profile-filter" value={effectivePathProfileId} onChange={(event) => setPathProfileId(event.target.value)}>{config.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><ChevronDown size={16} /></div>
          <span className="path-count">{accountPresets.length} 条路径</span>
        </div>
        {!accountPresets.length ? <SettingsEmpty title="该账号下还没有常用路径" text="点击右上角“添加路径”，为当前账号配置常用路径。" /> : <div className="config-list">{accountPresets.map((preset) => <div className="config-row" key={preset.id}>
          <span className="config-icon path"><FolderOpen size={20} /></span><div className="config-main"><div><strong>{preset.name}</strong>{preset.isDefault && <em>默认</em>}{categoryNameOf(preset.categoryId) && <em className="category-tag">{categoryNameOf(preset.categoryId)}</em>}</div>{preset.description && <small>{preset.description}</small>}<span>{fullPath(preset)}</span></div>
          <span className="profile-name">{config.profiles.find((item) => item.id === preset.profileId)?.name}</span>
          <button className="icon-button small" title="编辑" onClick={() => setPresetForm(preset)}><Pencil size={16} /></button>
          <button className="icon-button small danger" title="删除" onClick={async () => onChange(await window.desktopApi.deletePreset(preset.id))}><Trash2 size={16} /></button>
        </div>)}</div>}
      </>}
    </section>}

    {tab === 'categories' && <section className="settings-section">
      <div className="section-heading"><div><h2>路径分类</h2><span>自定义分类，可在“上传中心”和“OSS 文件”中按分类筛选常用路径</span></div></div>
      <div className="category-add">
        <input value={categoryName} placeholder="输入分类名称，例如：正式发布 / 测试环境" onChange={(event) => setCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && categoryName.trim()) addCategory() }} />
        <button className="primary compact" disabled={!categoryName.trim()} onClick={addCategory}><Plus size={16} />添加分类</button>
      </div>
      {!config.categories.length ? <SettingsEmpty title="还没有路径分类" text="添加分类后，可在上传中心与 OSS 文件中按分类筛选常用路径。" /> : <div className="config-list">{config.categories.map((category) => {
        const count = config.presets.filter((preset) => preset.categoryId === category.id).length
        return <div className="config-row" key={category.id}>
          <span className="config-icon path"><FolderSearch size={20} /></span>
          <div className="config-main"><div><strong>{category.name}</strong><em className="category-tag">分类</em></div><span>{count} 个常用路径</span></div>
          <span className="profile-name">路径分类</span>
          <button className="icon-button small danger" title="删除分类" onClick={async () => { if (window.confirm(`删除分类“${category.name}”？其下 ${count} 个常用路径将变为未分类。`)) onChange(await window.desktopApi.deleteCategory(category.id)) }}><Trash2 size={16} /></button>
        </div>
      })}</div>}
    </section>}

    {tab === 'upload' && <UploadPreferences config={config} onChange={onChange} />}

    {profileForm && <Modal title={config.profiles.some((item) => item.id === profileForm.id) ? '编辑 OSS 账号' : '添加 OSS 账号'} onClose={() => setProfileForm(null)}>
      <form onSubmit={async (event) => { event.preventDefault(); onChange(await window.desktopApi.saveProfile(profileForm)); setProfileForm(null) }}>
        <div className="form-grid">
          <Field label="配置名称"><input required value={profileForm.name} placeholder="例如：生产环境" onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} /></Field>
          <Field label="Region"><input value={profileForm.region} placeholder="oss-cn-hangzhou" onChange={(e) => setProfileForm({ ...profileForm, region: e.target.value })} /></Field>
          <Field label="Endpoint" wide><input required value={profileForm.endpoint} placeholder="oss-cn-hangzhou.aliyuncs.com" onChange={(e) => setProfileForm({ ...profileForm, endpoint: e.target.value })} /></Field>
          <Field label="AccessKey ID" wide><input required value={profileForm.accessKeyId} onChange={(e) => setProfileForm({ ...profileForm, accessKeyId: e.target.value })} /></Field>
          <Field label={`AccessKey Secret${profileForm.hasSecret ? '（留空则不修改）' : ''}`} wide><input required={!profileForm.hasSecret} type="password" value={profileForm.accessKeySecret || ''} onChange={(e) => setProfileForm({ ...profileForm, accessKeySecret: e.target.value })} /></Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={profileForm.isDefault} onChange={(e) => setProfileForm({ ...profileForm, isDefault: e.target.checked })} />设为默认 OSS 账号</label>
        {message && <div className={`test-message ${message.startsWith('连接成功') ? 'ok' : ''}`}>{message}</div>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={async () => { setMessage('正在测试连接...'); const result = await window.desktopApi.testConnection(profileForm); setMessage(result.message) }}><RefreshCw size={16} />测试连接</button><span /><button type="button" className="text-button" onClick={() => setProfileForm(null)}>取消</button><button className="primary">保存配置</button></div>
      </form>
    </Modal>}

    {presetForm && <Modal title={config.presets.some((item) => item.id === presetForm.id) ? '编辑常用路径' : '添加常用路径'} onClose={() => setPresetForm(null)}>
      <form onSubmit={async (event) => { event.preventDefault(); onChange(await window.desktopApi.savePreset(presetForm)); setPresetForm(null) }}>
        <div className="form-grid">
          <Field label="路径名称"><input required value={presetForm.name} placeholder="例如：生产安装包" onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })} /></Field>
          {config.profiles.length > 1 ? <Field label="使用账号"><select required value={presetForm.profileId} onChange={(e) => setPresetForm({ ...presetForm, profileId: e.target.value })}>{config.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field> : <Field label="使用账号"><div className="account-reference"><Check size={15} />{config.profiles[0]?.name}</div></Field>}
          <Field label="Bucket"><input required value={presetForm.bucket} placeholder="my-bucket" onChange={(e) => setPresetForm({ ...presetForm, bucket: e.target.value })} /></Field>
          <Field label="目录前缀"><input value={presetForm.prefix} placeholder="releases/windows" onChange={(e) => setPresetForm({ ...presetForm, prefix: e.target.value })} /></Field>
          <Field label="分类"><select value={presetForm.categoryId || ''} onChange={(e) => setPresetForm({ ...presetForm, categoryId: e.target.value || undefined })}><option value="">未分类</option>{config.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
          <Field label="路径备注（仅用于显示）" wide><input value={presetForm.description || ''} placeholder="例如：桌面客户端正式版本发布" onChange={(e) => setPresetForm({ ...presetForm, description: e.target.value })} /></Field>
        </div>
        <div className="path-callout"><span>完整路径</span><strong>{fullPath(presetForm)}</strong></div>
        <label className="checkbox"><input type="checkbox" checked={presetForm.isDefault} onChange={(e) => setPresetForm({ ...presetForm, isDefault: e.target.checked })} />设为默认上传路径</label>
        <div className="modal-actions"><span /><span /><button type="button" className="text-button" onClick={() => setPresetForm(null)}>取消</button><button className="primary">保存路径</button></div>
      </form>
    </Modal>}
  </>
}

function UploadPreferences({ config, onChange }: { config: AppConfig; onChange: (config: AppConfig) => void }) {
  const [concurrentUploads, setConcurrentUploads] = useState(config.concurrentUploads)
  const [conflictStrategy, setConflictStrategy] = useState(config.conflictStrategy)
  const changed = concurrentUploads !== config.concurrentUploads || conflictStrategy !== config.conflictStrategy
  return <section className="settings-section preferences">
    <div className="section-heading"><div><h2>上传设置</h2><span>控制并发任务和同名文件处理方式</span></div></div>
    <div className="preference-row"><div><strong>同时上传任务数</strong><span>建议保持在 2 到 4 个，以兼顾速度与稳定性</span></div><div className="stepper"><button onClick={() => setConcurrentUploads(Math.max(1, concurrentUploads - 1))}>−</button><b>{concurrentUploads}</b><button onClick={() => setConcurrentUploads(Math.min(8, concurrentUploads + 1))}>+</button></div></div>
    <div className="preference-row"><div><strong>同名文件</strong><span>目标位置已存在同名对象时的处理方式</span></div><div className="segmented"><button className={conflictStrategy === 'overwrite' ? 'active' : ''} onClick={() => setConflictStrategy('overwrite')}>覆盖</button><button className={conflictStrategy === 'skip' ? 'active' : ''} onClick={() => setConflictStrategy('skip')}>跳过</button></div></div>
    <div className="save-bar"><button className="primary" disabled={!changed} onClick={async () => onChange(await window.desktopApi.savePreferences({ concurrentUploads, conflictStrategy }))}>保存设置</button></div>
  </section>
}

function TargetPickerModal({ config, primaryId, selectedIds, onClose, onSave }: { config: AppConfig; primaryId: string; selectedIds: string[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [draft, setDraft] = useState(selectedIds)
  const toggle = (id: string, checked: boolean) => setDraft((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
  return <Modal title="选择附加上传目标" onClose={onClose}>
    <div className="target-picker">
      <p>同一批文件会分别上传到每个已勾选路径，任务进度互相独立。</p>
      <div className="target-picker-list">{config.profiles.map((profile) => {
        const presets = config.presets.filter((preset) => preset.profileId === profile.id)
        if (!presets.length) return null
        return <section key={profile.id}><h3><Cloud size={15} />{profile.name}</h3>{presets.map((preset) => <label className="target-option" key={preset.id}>
          <input type="checkbox" checked={draft.includes(preset.id)} disabled={preset.id === primaryId} onChange={(event) => toggle(preset.id, event.target.checked)} />
          <span><strong>{preset.name}</strong><small>{preset.description || '未填写备注'}</small><code>{fullPath(preset)}</code></span>
          {preset.id === primaryId && <em>主目标</em>}
        </label>)}</section>
      })}</div>
      <div className="target-picker-footer"><span>已选择 {draft.length} 个位置</span><button className="text-button" onClick={onClose}>取消</button><button className="primary" onClick={() => onSave(primaryId && !draft.includes(primaryId) ? [primaryId, ...draft] : draft)}>确定</button></div>
    </div>
  </Modal>
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className={`modal${wide ? ' wide' : ''}`}><div className="modal-header"><h2>{title}</h2><button className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></div>{children}</div></div>
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}</label>
}

function SettingsEmpty({ title, text }: { title: string; text: string }) {
  return <div className="settings-empty"><Cloud size={25} /><strong>{title}</strong><span>{text}</span></div>
}

function FolderPickerModal({ root, tree, preset, subfolder, onClose, onConfirm }: {
  root: string
  tree: FolderTreeNode
  preset?: UploadPreset
  subfolder?: string
  onClose: () => void
  onConfirm: (selectedPaths: string[]) => void | Promise<void>
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([tree.relativePath]))
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const subfolderPrefix = normalizePrefix(subfolder || '')

  const toggleExpand = (relativePath: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(relativePath)) next.delete(relativePath)
      else next.add(relativePath)
      return next
    })
  }

  const expandAll = () => {
    const all: string[] = []
    const walk = (node: FolderTreeNode) => {
      if (node.isFolder) all.push(node.relativePath)
      node.children.forEach(walk)
    }
    walk(tree)
    setExpanded(new Set(all))
  }

  const collapseAll = () => setExpanded(new Set([tree.relativePath]))

  const toggleCheck = (node: FolderTreeNode) => {
    const isChecked = checked.has(node.relativePath)
    setChecked((current) => {
      const next = new Set(current)
      const affected: string[] = [node.relativePath]
      const walk = (item: FolderTreeNode) => {
        item.children.forEach((child) => { affected.push(child.relativePath); walk(child) })
      }
      walk(node)
      affected.forEach((relativePath) => { if (isChecked) next.delete(relativePath); else next.add(relativePath) })
      return next
    })
  }

  const selectAll = () => {
    const all: string[] = []
    const walk = (node: FolderTreeNode) => {
      all.push(node.relativePath)
      node.children.forEach(walk)
    }
    walk(tree)
    setChecked(new Set(all))
  }

  const clearAll = () => setChecked(new Set())

  const summary = useMemo(() => {
    // 只统计最顶层勾选节点（其祖先未被勾选；根节点 '' 视为包含整棵树），避免重复统计
    const sorted = [...checked].sort((a, b) => a.split('/').length - b.split('/').length)
    const topLevel: string[] = []
    for (const candidate of sorted) {
      const covered = topLevel.some((ancestor) =>
        candidate === ancestor || ancestor === '' || candidate.startsWith(`${ancestor}/`))
      if (covered) continue
      topLevel.push(candidate)
    }
    const findNode = (node: FolderTreeNode, relativePath: string): FolderTreeNode | undefined => {
      if (node.relativePath === relativePath) return node
      for (const child of node.children) {
        const found = findNode(child, relativePath)
        if (found) return found
      }
      return undefined
    }
    let fileCount = 0
    let size = 0
    const folderNames: string[] = []
    for (const relativePath of topLevel) {
      const node = findNode(tree, relativePath)
      if (!node) continue
      fileCount += node.fileCount
      size += node.size
      if (node.relativePath) folderNames.push(node.relativePath)
    }
    return { fileCount, size, folderNames }
  }, [checked, tree])

  const handleConfirm = async () => {
    if (!summary.fileCount || submitting) return
    setSubmitting(true)
    try {
      await onConfirm([...checked])
    } finally {
      setSubmitting(false)
    }
  }

  return <Modal title="选择要上传的文件夹" wide onClose={onClose}>
    <div className="folder-picker">
      <p className="folder-picker-hint">已读取本地项目根目录，勾选其中要上传的版本 / 子文件夹（可多选）。上传到 OSS 后会按 <b>版本名 / 子目录</b> 的结构保留层级，例如 <code>v1.0/build/app.zip</code>。</p>
      <div className="folder-picker-toolbar">
        <span className="folder-root" title={root}>{root}</span>
        <div className="folder-toolbar-actions">
          <button className="text-button" onClick={expandAll}>展开全部</button>
          <button className="text-button" onClick={collapseAll}>折叠全部</button>
          <button className="text-button" onClick={selectAll}>全选</button>
          <button className="text-button" onClick={clearAll}>清空</button>
        </div>
      </div>
      <div className="folder-tree">
        <FolderTreeBranch node={tree} depth={0} expanded={expanded} checked={checked} onToggleExpand={toggleExpand} onToggleCheck={toggleCheck} />
      </div>
      <div className="folder-picker-footer">
        <span className="folder-selected">{summary.fileCount ? `已选 ${summary.fileCount} 个文件 · ${formatBytes(summary.size)}` : '未勾选任何内容'}</span>
        <span className="folder-preview" title={preset ? `${fullPath(preset)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}${summary.folderNames.join(' / ')}` : ''}>{preset ? (summary.folderNames.length
          ? `OSS 目标：${fullPath(preset)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}${summary.folderNames.slice(0, 3).join(' / ')}${summary.folderNames.length > 3 ? ` 等 ${summary.folderNames.length} 个目录` : ''}`
          : `OSS 目标：${fullPath(preset)}${subfolderPrefix ? `${subfolderPrefix}/` : ''}`) : '未选择上传路径'}</span>
        <button className="secondary" onClick={onClose}>取消</button>
        <button className="primary" disabled={!summary.fileCount || submitting} onClick={handleConfirm}>{submitting ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />}{submitting ? '正在添加...' : `添加 ${summary.fileCount} 个文件`}</button>
      </div>
    </div>
  </Modal>
}

function FolderTreeBranch({ node, depth, expanded, checked, onToggleExpand, onToggleCheck }: {
  node: FolderTreeNode
  depth: number
  expanded: Set<string>
  checked: Set<string>
  onToggleExpand: (relativePath: string) => void
  onToggleCheck: (node: FolderTreeNode) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(node.relativePath)
  const isChecked = checked.has(node.relativePath)
  let partChecked = false
  if (!isChecked) {
    const hasCheckedDescendant = (item: FolderTreeNode): boolean =>
      checked.has(item.relativePath) || item.children.some(hasCheckedDescendant)
    partChecked = node.children.some(hasCheckedDescendant)
  }
  return <>
    <div className="tree-row" style={{ paddingLeft: `${9 + depth * 22}px` }}>
      <button
        type="button"
        className={`tree-expander${hasChildren ? '' : ' leaf'}${isExpanded ? ' open' : ''}`}
        disabled={!hasChildren}
        title={hasChildren ? (isExpanded ? '折叠' : '展开') : undefined}
        onClick={() => onToggleExpand(node.relativePath)}
      >
        {hasChildren ? <ChevronRight size={13} /> : <span className="tree-leaf-dot" />}
      </button>
      <input
        type="checkbox"
        aria-label={`选择 ${node.relativePath || node.name}`}
        checked={isChecked}
        ref={(el) => { if (el) el.indeterminate = partChecked }}
        onChange={() => onToggleCheck(node)}
      />
      {node.isFolder ? <FolderOpen size={16} /> : <FileText size={16} />}
      <span className="tree-name" title={node.relativePath}>{node.name || '根目录'}</span>
      <span className="tree-meta">{node.isFolder ? `${node.fileCount} 项` : formatBytes(node.size)}</span>
      <span className="tree-size">{node.isFolder ? formatBytes(node.size) : ''}</span>
    </div>
    {hasChildren && isExpanded && node.children.map((child) => (
      <FolderTreeBranch key={child.relativePath} node={child} depth={depth + 1} expanded={expanded} checked={checked} onToggleExpand={onToggleExpand} onToggleCheck={onToggleCheck} />
    ))}
  </>
}

function RenameForm({ item, busy, onCancel, onConfirm }: { item: OssObjectItem; busy: boolean; onCancel: () => void; onConfirm: (name: string) => void }) {
  const [name, setName] = useState(item.name)
  return <form className="op-form" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !busy) onConfirm(name.trim()) }}>
    <p className="op-tip">对象：<code>{item.key}{item.isFolder ? '/' : ''}</code></p>
    {item.isFolder && <p className="op-warn">这是文件夹，重命名后其下所有对象的路径都会同步更新。</p>}
    <Field label="新名称"><input autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></Field>
    <div className="op-actions"><button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy || !name.trim()}>保存</button></div>
  </form>
}

function OssFolderPicker({ profileId, bucket, region, mode, items, busy, onCancel, onSelect }: {
  profileId: string
  bucket: string
  region?: string
  mode: 'copy' | 'move'
  items: OssObjectItem[]
  busy: boolean
  onCancel: () => void
  onSelect: (prefix: string) => void
}) {
  const [currentPrefix, setCurrentPrefix] = useState('')
  const [folders, setFolders] = useState<OssObjectItem[]>([])
  const [fileCount, setFileCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const action = mode === 'copy' ? '复制' : '移动'

  useEffect(() => {
    if (!profileId || !bucket) return
    let cancelled = false
    setLoading(true)
    setError('')
    window.desktopApi.listObjects({ profileId, bucket, prefix: currentPrefix, region })
      .then((list) => {
        if (cancelled) return
        setFolders(list.filter((item) => item.isFolder))
        setFileCount(list.filter((item) => !item.isFolder).length)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : '读取目录失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [profileId, bucket, currentPrefix, region, refreshKey])

  const goUp = () => {
    if (!currentPrefix) return
    setCurrentPrefix(currentPrefix.includes('/') ? currentPrefix.slice(0, currentPrefix.lastIndexOf('/')) : '')
  }

  return <div className="op-form">
    <p className="op-tip">{action}以下 {items.length} 项到所选目录（文件夹会包含其下所有内容）：</p>
    <div className="op-target-list">{items.slice(0, 6).map((item) => <code key={item.key}>{item.key}{item.isFolder ? '/' : ''}</code>)}{items.length > 6 && <code>…等 {items.length} 项</code>}</div>

    <div className="picker-path">
      <span className="picker-breadcrumb" title={currentPrefix || 'Bucket 根目录'}>{currentPrefix ? `目录：${currentPrefix}/` : '目录：Bucket 根目录'}</span>
      <div className="picker-nav">
        <button type="button" className="text-button" disabled={!currentPrefix || busy || loading} onClick={goUp}><ArrowUp size={13} />上级</button>
        <button type="button" className="icon-button small" title="刷新目录" disabled={busy || loading} onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={14} /></button>
      </div>
    </div>

    <div className="picker-dirs">
      {loading ? <div className="picker-empty"><LoaderCircle className="spin" size={18} />正在读取目录...</div>
        : error ? <div className="picker-empty">{error}</div>
        : !folders.length ? <div className="picker-empty">{fileCount ? '此目录下没有子文件夹' : '当前目录为空'}</div>
        : folders.map((folder) => <button type="button" key={folder.key} className="picker-dir" disabled={busy} onClick={() => setCurrentPrefix(folder.key.replace(/\/+$/, ''))}><FolderOpen size={16} /><span>{folder.name}</span><ChevronRight size={13} /></button>)}
    </div>
    {!loading && !error && <div className="picker-filecount">本目录包含 {fileCount} 个文件；选中的 {items.length} 项将以各自的名称进入所选目录内。</div>}

    {mode === 'move' && <p className="op-warn">移动完成后，原位置的对象会被删除。</p>}

    <div className="op-actions">
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="primary" disabled={busy || loading} onClick={() => onSelect(currentPrefix)}><Check size={16} />选择当前目录</button>
    </div>
  </div>
}

export default App
