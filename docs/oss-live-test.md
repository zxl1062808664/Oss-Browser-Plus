# OSS 真实联调测试

真实联调只允许在 `oss-quick-test/` 前缀下运行。测试会创建独立的 `run-时间戳-随机值/` 目录，验证完成后自动清理该运行目录。

## 安全约束

- 必须显式设置 `OSS_TEST_CONFIRM=YES_I_UNDERSTAND`。
- `OSS_TEST_PREFIX` 只能是 `oss-quick-test` 或其子目录。
- 使用专用测试 Bucket 或仅具备测试前缀权限的 RAM 用户。
- 不要使用生产 Bucket 的全量读写 AccessKey。

## PowerShell 配置

```powershell
$env:OSS_TEST_CONFIRM = 'YES_I_UNDERSTAND'
$env:OSS_TEST_ACCESS_KEY_ID = '<test-access-key-id>'
$env:OSS_TEST_ACCESS_KEY_SECRET = '<test-access-key-secret>'
$env:OSS_TEST_BUCKET = '<test-bucket>'
$env:OSS_TEST_REGION = 'oss-cn-hangzhou'
$env:OSS_TEST_PREFIX = 'oss-quick-test'

npm run test:oss
```

使用自定义 Endpoint 时可以设置 `OSS_TEST_ENDPOINT`。`OSS_TEST_REGION` 和 `OSS_TEST_ENDPOINT` 至少设置一个。

## 覆盖范围

- 创建空文件夹目录标记。
- 使用小分页读取完整目录。
- 复制文件并验证目标存在。
- 通过复制后删除验证文件重命名。
- 通过复制后删除验证文件移动。
- 删除包含目录标记的源文件夹。
- 清理本次测试创建的全部对象。

测试失败时 `finally` 清理仍会执行。如果进程被强制终止，可以在 Bucket 的 `oss-quick-test/` 下按运行目录手动确认和清理残留对象。
