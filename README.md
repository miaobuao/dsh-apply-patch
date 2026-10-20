# dsh-apply-patch

[English](README.en.md)

为 DSH 提供 Codex 风格的 `apply_patch` 工具，支持新增、修改、删除和移动文件。
补丁解析与应用行为参照 Codex，所有文件变更均经过 DSH 沙盒。

## 安装

```bash
dsh plugin --profile web add github:miaobuao/dsh-apply-patch
```

## 使用

安装后 `apply_patch` 立即生效，无需额外配置。插件页面位于 **设置 → 插件 →
dsh-apply-patch**（与网页搜索等官方插件同一位置）。页面上的前两个开关决定是否
隐藏 DSH 内置的文件编辑工具：

- 隐藏内置 `edit` 工具（定点文本编辑）
- 隐藏内置 `write` 工具（整文件写入）

两者默认都开启，即模型只看到 `apply_patch`；关掉开关即可让对应的内置工具重新出现。

第三个开关 **允许覆盖未读取的文件** 默认开启，与 Codex 行为一致：`Add File` /
`Move to` 可以覆盖已存在但模型没读过的文件，`Delete File` 也可以直接删除。关闭后，
这三类操作要求模型先读取目标文件，否则返回读后写策略的错误。`Update File` 不受影响
（补丁上下文匹配本身即证明模型读过文件）。

其他行为：

- 多文件补丁按补丁顺序执行，中途失败不会回滚已完成的改动；错误信息会列出已经生效的
  `A`/`M`/`D` 路径。
- 隐藏逻辑按工具名匹配内置 `edit` / `write`；如有其他插件注册同名工具，也会一并被
  隐藏或拒绝调用。
- `*** Move to:` 指向与源文件相同的路径时按原地更新处理，不会先写后删。
- `Delete File` 与 `Move to` 的删除步骤通过 DSH 沙盒 shell 执行，需要宿主挂载
  sandboxed shell；`Move to` 采用“写目标 + 删源文件”，不保留源文件权限位（上游
  `FileSystem` 未提供 remove/rename 能力）。每次删除单独启动一次沙盒 shell 以保留
  逐文件的失败归因与顺序语义。

## 许可与来源

本项目基于 [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch)，
由 miaobuao 修改，整体按 [GPL-3.0-or-later](LICENSE) 分发。
原作者版权及 MIT 许可保留于 [LICENSES/MIT.txt](LICENSES/MIT.txt)。
Codex 相关改编和测试数据的 Apache-2.0 许可见
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，完整来源及修改说明见 [NOTICE](NOTICE)。
