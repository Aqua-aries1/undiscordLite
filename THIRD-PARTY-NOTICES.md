# 第三方代码声明

本项目（UndiscordLite，Vencord userplugin）以 **GPL-3.0-or-later** 发布，见 `LICENSE`。
其中八个模块并非本项目原创，下面的声明按各自许可的要求保留。

## 1. victornpb/undiscord

`core.ts` / `helpers.ts` / `ui.ts` / `drag.ts` / `exportImport.ts` / `styles.ts` /
`template.ts` / `zhLayer.ts` 的最初来源是 Undiscord 项目：

- 仓库：https://github.com/victornpb/undiscord
- 许可：MIT
- 版权：Copyright (c) 2019-2025 Victornpb and contributors

```
MIT License

Copyright (c) 2019-2025 Victornpb and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

Attribution: Original project (https://github.com/victornpb/undiscord)
Derivatives must keep attribution comments to the original project in the code
readme and license.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Undiscord Lite 1.3.0-zh（OrbitalCheese）

本项目的八个模块实际是从 **Undiscord Lite 1.3.0-zh** 这个用户脚本机械切分出来的
（`tools/split-undiscord.mjs`），并非直接取自上面的原始仓库。

- 文件：`Undiscord-Lite-1.3.0-zh.user.js`（v1.3.0，337515 B）
- 许可：MIT（脚本自述）
- 原仓库：**已下线**（`@namespace` / `@homepageURL` 指向的
  `https://github.com/OrbitalCheese/undiscord-lite` 现在返回 404，账号 `OrbitalCheese`
  仍在但已无公开仓库），所以这里不把它当活链接用，只作来源记录。

脚本自己的元数据块（逐字）：

```
// ==UserScript==
// @name        Undiscord Lite 中文优化版
// @description Discord 消息批量删除工具（中文界面、响应式布局与安全日志输出）。
// @version     1.3.0
// @namespace   https://github.com/OrbitalCheese/undiscord-lite
// @grant       none
// @run-at      document-idle
// @noframes
// @author      OrbitalCheese
// @license     MIT
// @homepageURL https://github.com/OrbitalCheese/undiscord-lite
// @supportURL  https://github.com/OrbitalCheese/undiscord-lite/issues
// ==/UserScript==
```

该脚本与上面的 `victornpb/undiscord` 共享代码谱系（例：`msToHMS` 的实现逐字节相同），
但它的头部没有保留后者的版权声明；本项目的文件头与本文档补上了这条归属。

## 3. Vencord

本插件是 Vencord 的 userplugin，跟 Vencord 一起构建、依赖 Vencord 的 API 与类型：

- 仓库：https://github.com/Vendicated/Vencord
- 许可：GPL-3.0-or-later
- 版权：Copyright (c) 2023 Vendicated and contributors

本项目自身的手写文件头也沿用同一 SPDX 标识（`GPL-3.0-or-later`）。
