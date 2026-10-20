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
dsh-apply-patch**（与网页搜索等官方插件同一位置），页面上有两个开关，决定是否
隐藏 DSH 内置的文件编辑工具：

- 隐藏内置 `edit` 工具（定点文本编辑）
- 隐藏内置 `write` 工具（整文件写入）

两者默认都开启，即模型只看到 `apply_patch`；关掉开关即可让对应的内置工具重新出现。
`Add File` 会覆盖已存在的文件；多文件补丁顺序执行，中途失败不会回滚已完成的改动。

## 许可与来源

本项目基于 [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch)，
由 miaobuao 修改，整体按 [GPL-3.0-or-later](LICENSE) 分发。
原作者版权及 MIT 许可保留于 [LICENSES/MIT.txt](LICENSES/MIT.txt)。
Codex 相关改编和测试数据的 Apache-2.0 许可见
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，完整来源及修改说明见 [NOTICE](NOTICE)。
