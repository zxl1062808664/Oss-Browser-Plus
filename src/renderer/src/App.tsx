import { useEffect, useMemo, useState } from 'react'
import {
  Check, ChevronDown, Clipboard, Cloud, FileUp, FolderOpen, Gauge, HardDriveUpload,
  ListChecks, LoaderCircle, Pencil, Plus, RefreshCw, Settings, Trash2, Upload, X
} from 'lucide-react'
import type { AppConfig, LocalUploadItem, OssProfile, ProfileInput, UploadPreset } from '../../shared/types'

type Page = 'upload' | 'settings'
type TaskStatus = 'waiting' | 'uploading' | 'success' | 'failed' | 'skipped'
type UploadTask = LocalUploadItem & { status: TaskStatus; progress: number; error?: string; objectName?: string }
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
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const selectedPreset = config.presets.find((item) => item.id === selectedPresetId)
  const selectedProfile = config.profiles.find((item) => item.id === selectedPreset?.profileId)
  const completed = tasks.filter((task) => ['success', 'skipped'].includes(task.status)).length
  const failed = tasks.filter((task) => task.status === 'failed').length
  const totalSize = tasks.reduce((sum, task) => sum + task.size, 0)
  const totalProgress = totalSize ? Math.round(tasks.reduce((sum, task) => sum + task.size * task.progress / 100, 0) / totalSize * 100) : 0

  useEffect(() => {
    window.desktopApi.getConfig().then((next) => {
      setConfig(next)
      setSelectedPresetId(next.presets.find((item) => item.isDefault)?.id || next.presets[0]?.id || '')
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

  const startUpload = async () => {
    if (!selectedPreset || !selectedProfile) return notify('请先配置并选择上传路径')
    const pending = tasks.filter((task) => task.status === 'waiting' || task.status === 'failed')
    if (!pending.length) return notify('没有待上传文件')
    setBusy(true)
    addLog('info', `开始上传 ${pending.length} 个文件到 ${fullPath(selectedPreset)}`)
    let cursor = 0
    const worker = async () => {
      while (cursor < pending.length) {
        const task = pending[cursor++]
        const objectName = [normalizePrefix(selectedPreset.prefix), task.relativePath].filter(Boolean).join('/')
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'uploading', progress: 0, error: undefined, objectName } : item))
        try {
          const result = await window.desktopApi.upload({
            taskId: task.id,
            absolutePath: task.absolutePath,
            objectName,
            profileId: selectedPreset.profileId,
            bucket: selectedPreset.bucket,
            conflictStrategy: config.conflictStrategy
          })
          const status: TaskStatus = result.skipped ? 'skipped' : 'success'
          setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status, progress: 100 } : item))
          addLog('success', `${result.skipped ? '已跳过' : '上传成功'}：${objectName}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'failed', error: message } : item))
          addLog('error', `上传失败：${objectName} · ${message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.concurrentUploads, pending.length) }, worker))
    setBusy(false)
  }

  const copyPath = async () => {
    if (!selectedPreset) return
    await window.desktopApi.copyText(fullPath(selectedPreset))
    notify('OSS 路径已复制')
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
            config={config} tasks={tasks} logs={logs} selectedPresetId={selectedPresetId}
            selectedPreset={selectedPreset} selectedProfile={selectedProfile} busy={busy}
            completed={completed} failed={failed} totalSize={totalSize} totalProgress={totalProgress}
            onPresetChange={setSelectedPresetId} onCopy={copyPath} onFiles={selectFiles} onFolder={selectFolder}
            onUpload={startUpload} onSettings={() => setPage('settings')}
            onRemove={(id) => setTasks((current) => current.filter((item) => item.id !== id))}
            onClear={() => setTasks((current) => current.filter((item) => !['success', 'skipped'].includes(item.status)))}
          />
        ) : (
          <SettingsPage config={config} onChange={(next) => { setConfig(next); if (!next.presets.some((item) => item.id === selectedPresetId)) setSelectedPresetId(next.presets.find((item) => item.isDefault)?.id || next.presets[0]?.id || '') }} />
        )}
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  )
}

interface UploadPageProps {
  config: AppConfig; tasks: UploadTask[]; logs: LogEntry[]; selectedPresetId: string
  selectedPreset?: UploadPreset; selectedProfile?: OssProfile; busy: boolean
  completed: number; failed: number; totalSize: number; totalProgress: number
  onPresetChange: (id: string) => void; onCopy: () => void; onFiles: () => void; onFolder: () => void
  onUpload: () => void; onSettings: () => void; onRemove: (id: string) => void; onClear: () => void
}

function UploadPage(props: UploadPageProps) {
  const { config, tasks, logs, selectedPreset, selectedProfile } = props
  return <>
    <header className="page-header">
      <div><h1>上传中心</h1><p>选择预设路径，添加文件后即可上传</p></div>
      <button className="icon-button" title="打开设置" onClick={props.onSettings}><Settings size={19} /></button>
    </header>

    {!config.presets.length ? <div className="empty-setup">
      <span className="empty-icon"><Cloud size={30} /></span>
      <h2>先添加一个上传路径</h2><p>配置 OSS 凭据和常用目录后，就可以在这里一键上传。</p>
      <button className="primary" onClick={props.onSettings}><Settings size={17} />前往设置</button>
    </div> : <>
      <section className="target-band">
        <div className="target-selector">
          <label htmlFor="target">上传到</label>
          <div className="select-wrap"><select id="target" value={props.selectedPresetId} onChange={(event) => props.onPresetChange(event.target.value)}>{config.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><ChevronDown size={16} /></div>
        </div>
        <div className="path-preview"><span>{fullPath(selectedPreset)}</span><button className="icon-button small" title="复制 OSS 路径" onClick={props.onCopy}><Clipboard size={17} /></button></div>
        <div className="connection"><span className="status-dot online" />{selectedProfile?.name}</div>
      </section>

      <section className="actions-row">
        <div className="add-actions">
          <button className="secondary" onClick={props.onFiles}><FileUp size={18} />选择文件</button>
          <button className="secondary" onClick={props.onFolder}><FolderOpen size={18} />选择文件夹</button>
        </div>
        <button className="primary upload-button" disabled={props.busy || !tasks.some((task) => task.status === 'waiting' || task.status === 'failed')} onClick={props.onUpload}>
          {props.busy ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}{props.busy ? '正在上传' : '开始上传'}
        </button>
      </section>

      <section className="summary-strip">
        <div><ListChecks size={18} /><span><b>{tasks.length}</b> 个文件</span></div>
        <div><Gauge size={18} /><span><b>{formatBytes(props.totalSize)}</b> 总大小</span></div>
        <div className="summary-progress"><span>{props.completed} 已完成{props.failed ? ` · ${props.failed} 失败` : ''}</span><div className="progress-track"><i style={{ width: `${props.totalProgress}%` }} /></div><b>{props.totalProgress}%</b></div>
      </section>

      <section className="task-section">
        <div className="section-heading"><div><h2>上传队列</h2><span>{tasks.filter((task) => task.status === 'waiting').length} 项等待</span></div>{props.completed > 0 && <button className="text-button" onClick={props.onClear}>清除已完成</button>}</div>
        <div className="task-table">
          <div className="task-head"><span>文件</span><span>大小</span><span>进度</span><span>状态</span><span /></div>
          {!tasks.length ? <div className="queue-empty"><HardDriveUpload size={28} /><span>上传队列为空</span><small>选择文件或文件夹以添加任务</small></div> : tasks.map((task) => <TaskRow key={task.id} task={task} onRemove={() => props.onRemove(task.id)} />)}
        </div>
      </section>
    </>}

    <section className="log-section">
      <div className="section-heading"><div><h2>运行日志</h2><span>最近 {logs.length} 条</span></div></div>
      <div className="log-list">{!logs.length ? <div className="log-empty">等待上传任务</div> : logs.slice(0, 6).map((log) => <div key={log.id} className={`log-line ${log.level}`}><time>{log.time}</time><span>{log.message}</span></div>)}</div>
    </section>
  </>
}

function TaskRow({ task, onRemove }: { task: UploadTask; onRemove: () => void }) {
  const labels: Record<TaskStatus, string> = { waiting: '等待中', uploading: '上传中', success: '已完成', failed: '失败', skipped: '已跳过' }
  return <div className="task-row">
    <div className="file-cell"><span className="file-icon"><FileUp size={17} /></span><div><strong title={task.relativePath}>{task.relativePath}</strong><small title={task.objectName}>{task.objectName || '等待分配目标路径'}</small></div></div>
    <span>{formatBytes(task.size)}</span>
    <div className="row-progress"><div className="progress-track"><i style={{ width: `${task.progress}%` }} /></div><span>{task.progress}%</span></div>
    <span className={`task-status ${task.status}`}>{task.status === 'uploading' && <LoaderCircle className="spin" size={14} />}{labels[task.status]}</span>
    <button className="icon-button small" title="移除任务" disabled={task.status === 'uploading'} onClick={onRemove}><X size={16} /></button>
    {task.error && <div className="task-error">{task.error}</div>}
  </div>
}

function SettingsPage({ config, onChange }: { config: AppConfig; onChange: (config: AppConfig) => void }) {
  const [tab, setTab] = useState<'oss' | 'paths' | 'upload'>('oss')
  const [profileForm, setProfileForm] = useState<ProfileInput | null>(null)
  const [presetForm, setPresetForm] = useState<UploadPreset | null>(null)
  const [message, setMessage] = useState('')
  const newProfile = (): ProfileInput => ({ id: uid(), name: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '', hasSecret: false, isDefault: !config.profiles.length })
  const newPreset = (): UploadPreset => ({ id: uid(), name: '', profileId: config.profiles[0]?.id || '', bucket: '', prefix: '', isDefault: !config.presets.length })

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
        <span className="config-icon path"><FolderOpen size={20} /></span><div className="config-main"><div><strong>{preset.name}</strong>{preset.isDefault && <em>默认</em>}</div><span>{fullPath(preset)}</span></div>
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
