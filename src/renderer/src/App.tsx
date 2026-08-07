import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronDown, CircleStop, Clipboard, Cloud, FileUp, FolderOpen, Gauge, HardDriveUpload,
  ListChecks, ListPlus, LoaderCircle, MapPin, Pencil, Plus, RefreshCw, Settings, Trash2, Upload, X
} from 'lucide-react'
import type { AppConfig, LocalUploadItem, OssProfile, ProfileInput, UploadPreset } from '../../shared/types'

type Page = 'upload' | 'settings'
type TaskStatus = 'waiting' | 'uploading' | 'success' | 'failed' | 'skipped' | 'cancelled'
type UploadTask = LocalUploadItem & { status: TaskStatus; progress: number; error?: string; objectName?: string; targetPresetId?: string }
type LogEntry = { id: string; time: string; level: 'info' | 'success' | 'error'; message: string }

const emptyConfig: AppConfig = { profiles: [], presets: [], concurrentUploads: 3, conflictStrategy: 'overwrite' }
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
  const cancelRequested = useRef(false)

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
  const selectFolder = async () => addItems(await window.desktopApi.selectFolder())

  const startUpload = async (onlyTaskId?: string) => {
    if (!selectedTargets.length) return notify('请至少选择一个上传目标')
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
    addLog('info', `开始执行 ${operations.length} 个上传任务，共 ${selectedTargets.length} 个目标`)
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
        const objectName = [normalizePrefix(target.prefix), task.relativePath].filter(Boolean).join('/')
        const displayPath = `${fullPath(target)}${task.relativePath}`
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
          addLog('success', `${result.skipped ? '已跳过' : '上传成功'}：${fullPath(target)}${task.relativePath}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (cancelRequested.current) {
            setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'cancelled', error: undefined } : item))
          } else {
            resultCounts.failed += 1
            setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'failed', error: message } : item))
            addLog('error', `上传失败：${fullPath(target)}${task.relativePath} · ${message}`)
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
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings size={19} />设置</button>
        </nav>
        <div className="sidebar-status"><span className={config.profiles.length ? 'status-dot online' : 'status-dot'} />{config.profiles.length ? `${config.profiles.length} 个 OSS 连接` : '尚未配置 OSS'}</div>
      </aside>

      <main className="content">
        {page === 'upload' ? (
          <UploadPage
            config={config} tasks={tasks} logs={logs} selectedProfileId={selectedProfileId} selectedPresetId={selectedPresetId}
            availablePresets={availablePresets} selectedTargets={selectedTargets}
            selectedPreset={selectedPreset} selectedProfile={selectedProfile} busy={busy}
            completed={completed} failed={failed} totalSize={totalSize} totalProgress={totalProgress}
            onProfileChange={selectProfile} onPresetChange={changePrimaryTarget} onTargetsChange={setSelectedTargetIds} onCopy={copyPath} onFiles={selectFiles} onFolder={selectFolder}
            onUpload={startUpload} onSettings={() => setPage('settings')}
            onRemove={(id) => setTasks((current) => current.filter((item) => item.id !== id))}
            onRetry={(id) => startUpload(id)}
            onClear={() => setTasks((current) => current.filter((item) => !['success', 'skipped'].includes(item.status)))}
            onCancelAll={cancelAll}
          />
        ) : (
          <SettingsPage config={config} onChange={applyConfig} />
        )}
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  )
}

interface UploadPageProps {
  config: AppConfig; tasks: UploadTask[]; logs: LogEntry[]; selectedProfileId: string; selectedPresetId: string
  availablePresets: UploadPreset[]; selectedTargets: UploadPreset[]
  selectedPreset?: UploadPreset; selectedProfile?: OssProfile; busy: boolean
  completed: number; failed: number; totalSize: number; totalProgress: number
  onProfileChange: (id: string) => void; onPresetChange: (id: string) => void; onTargetsChange: (ids: string[]) => void; onCopy: () => void; onFiles: () => void; onFolder: () => void
  onUpload: () => void; onSettings: () => void; onRemove: (id: string) => void; onRetry: (id: string) => void; onClear: () => void; onCancelAll: () => void
}

function UploadPage(props: UploadPageProps) {
  const { config, tasks, logs, selectedPreset, selectedProfile } = props
  const [showTargetPicker, setShowTargetPicker] = useState(false)
  return <>
    <header className="page-header">
      <div><h1>上传中心</h1><p>选择预设路径，添加文件后即可上传</p></div>
      <button className="icon-button" title="打开设置" onClick={props.onSettings}><Settings size={19} /></button>
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
          <label htmlFor="path-target">上传路径</label>
          <div className="select-wrap"><select id="path-target" disabled={props.busy || !props.availablePresets.length} value={props.selectedPresetId} onChange={(event) => props.onPresetChange(event.target.value)}>{props.availablePresets.length ? props.availablePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.description ? ` · ${preset.description}` : ''}</option>) : <option value="">该账号暂无上传路径</option>}</select><ChevronDown size={16} /></div>
        </div>
        <div className="path-field"><label>路径预览</label><div className={`path-preview ${selectedPreset ? '' : 'empty'}`}><span>{selectedPreset ? fullPath(selectedPreset) : '请前往设置为该账号添加路径'}</span><button className="icon-button small" disabled={!selectedPreset} title="复制 OSS 路径" onClick={props.onCopy}><Clipboard size={17} /></button></div></div>
      </section>

      <section className="target-summary">
        <div className="target-summary-title"><MapPin size={16} /><span>本次上传到 <b>{props.selectedTargets.length}</b> 个位置</span></div>
        <div className="target-chips">{props.selectedTargets.map((target) => <span className="target-chip" key={target.id} title={`${fullPath(target)}${target.description ? `\n${target.description}` : ''}`}><b>{target.name}</b>{target.description && <small>{target.description}</small>}{target.id !== props.selectedPresetId && !props.busy && <button title="移除附加目标" onClick={() => props.onTargetsChange(props.selectedTargets.filter((item) => item.id !== target.id).map((item) => item.id))}><X size={13} /></button>}</span>)}</div>
        <button className="secondary compact" disabled={props.busy || !config.presets.length} onClick={() => setShowTargetPicker(true)}><ListPlus size={15} />添加其他目标</button>
      </section>

      <section className="actions-row">
        <div className="add-actions">
          <button className="secondary" onClick={props.onFiles}><FileUp size={18} />选择文件</button>
          <button className="secondary" onClick={props.onFolder}><FolderOpen size={18} />选择文件夹</button>
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

    <section className="log-section">
      <div className="section-heading"><div><h2>运行日志</h2><span>最近 {logs.length} 条</span></div></div>
      <div className="log-list">{!logs.length ? <div className="log-empty">等待上传任务</div> : logs.slice(0, 6).map((log) => <div key={log.id} className={`log-line ${log.level}`}><time>{log.time}</time><span>{log.message}</span></div>)}</div>
    </section>
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
  const [tab, setTab] = useState<'oss' | 'paths' | 'upload'>('oss')
  const [profileForm, setProfileForm] = useState<ProfileInput | null>(null)
  const [presetForm, setPresetForm] = useState<UploadPreset | null>(null)
  const [message, setMessage] = useState('')
  const newProfile = (): ProfileInput => ({ id: uid(), name: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '', hasSecret: false, isDefault: !config.profiles.length })
  const newPreset = (): UploadPreset => ({ id: uid(), name: '', description: '', profileId: config.profiles[0]?.id || '', bucket: '', prefix: '', isDefault: !config.presets.length })

  return <>
    <header className="page-header"><div><h1>设置</h1><p>账号凭据只需保存一次，常用路径可重复使用该账号</p></div></header>
    <div className="settings-tabs">
      <button className={tab === 'oss' ? 'active' : ''} onClick={() => setTab('oss')}>账号配置</button>
      <button className={tab === 'paths' ? 'active' : ''} onClick={() => setTab('paths')}>常用路径</button>
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
      <div className="section-heading"><div><h2>常用路径</h2><span>路径会直接使用已保存的账号，不需要重复填写凭据</span></div><button className="primary compact" disabled={!config.profiles.length} onClick={() => setPresetForm(newPreset())}><Plus size={17} />添加路径</button></div>
      {!config.presets.length ? <SettingsEmpty title="还没有常用路径" text={config.profiles.length ? '只需填写 Bucket 和目录前缀，不会再次要求 AccessKey。' : '请先添加一个 OSS 账号。'} /> : <div className="config-list">{config.presets.map((preset) => <div className="config-row" key={preset.id}>
        <span className="config-icon path"><FolderOpen size={20} /></span><div className="config-main"><div><strong>{preset.name}</strong>{preset.isDefault && <em>默认</em>}</div>{preset.description && <small>{preset.description}</small>}<span>{fullPath(preset)}</span></div>
        <span className="profile-name">{config.profiles.find((item) => item.id === preset.profileId)?.name}</span>
        <button className="icon-button small" title="编辑" onClick={() => setPresetForm(preset)}><Pencil size={16} /></button>
        <button className="icon-button small danger" title="删除" onClick={async () => onChange(await window.desktopApi.deletePreset(preset.id))}><Trash2 size={16} /></button>
      </div>)}</div>}
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="modal"><div className="modal-header"><h2>{title}</h2><button className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></div>{children}</div></div>
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}</label>
}

function SettingsEmpty({ title, text }: { title: string; text: string }) {
  return <div className="settings-empty"><Cloud size={25} /><strong>{title}</strong><span>{text}</span></div>
}

export default App
