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

## 文本在线编辑的手工验证

文本保存是覆盖写入，自动化测试不会覆盖该路径，建议在测试 Bucket 上手工确认以下场景：

| 场景 | 预期结果 |
| --- | --- |
| 编辑 500 KB 以内的 txt 并保存 | 保存成功，列表中的大小与修改时间刷新，重新打开内容为修改后的值 |
| 打开超过 500 KB 的 txt | 只读展示，提示超过 500 KB 请下载后编辑，无保存按钮 |
| 打开 png / zip 等非文本文件 | 不进入编辑态，图片直接显示 |
| 保存前后用其他工具修改同一对象再保存 | 提示文件已被其他人修改，要求重新打开，不覆盖对方改动 |
| 保存后关闭再打开 | 内容与行尾风格保持一致，CRLF 文件不会被整体改成 LF |

非 UTF-8（如 GBK）编码的文本文件打开时可能乱码，属于已知限制，请下载后用本地编辑器处理。

