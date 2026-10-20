# dsh-apply-patch

[English](README.en.md)

为 DSH 提供 Codex 风格的 `apply_patch` 工具，支持新增、修改、删除和移动文件。
补丁解析与应用行为参照 Codex，所有文件变更均经过 DSH 沙盒。

## 安装

```bash
dsh plugin --profile web add github:miaobuao/dsh-apply-patch
```

## 许可与来源

本项目基于 [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch)，
由 miaobuao 修改，整体按 [GPL-3.0-or-later](LICENSE) 分发。
原作者版权及 MIT 许可保留于 [LICENSES/MIT.txt](LICENSES/MIT.txt)。
Codex 相关改编和测试数据的 Apache-2.0 许可见
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，完整来源及修改说明见 [NOTICE](NOTICE)。
