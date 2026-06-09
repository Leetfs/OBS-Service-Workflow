# OBS Service Workflow for VS Code

一个围绕当前 `.spec` 文件工作的轻量 OBS/Open Build Service 扩展。

打开 `.spec` 后，VSCode 左侧 Activity Bar 会出现独立的 `OBS` 图标，点进去就是 `OBS Workflow` 面板。现在只保留核心能力：

- 创建 OBS 包
- 生成并提交 `_service`
- 为 Source URL 刷新 `#!RemoteAsset` sha256
- 删除 OBS 包
- 重新构建 OBS 包
- Trigger source services
- 流式查看 build log
- 近实时显示构建状态

扩展不重写 OBS 协议，所有动作都调用你本机已配置好的 `osc`。

## _service 模型

源码由你的云端 Git 仓库管理，OBS 包里只维护一个 `_service` 文件。创建包或更新 `_service` 时，扩展会生成：

```xml
<services>
  <service name="obs_scm">
    <param name="scm">git</param>
    <param name="url">https://github.com/Leetfs/openRuyi.git</param>
    <param name="revision">当前 Git 分支</param>
    <param name="extract">当前 spec 上级目录相对 Git 根目录的路径/*</param>
  </service>
  <service name="download_files"/>
</services>
```

比如当前分支是 `perl-IO-Compress`，spec 在 `SPECS/perl-IO-Compress/perl-IO-Compress.spec`，则：

```xml
<param name="revision">perl-IO-Compress</param>
<param name="extract">SPECS/perl-IO-Compress/*</param>
```

Git 仓库 URL 不需要在扩展里配置。扩展会直接读取当前 `.spec` 所在 Git 仓库的 `remote.origin.url`，并写进 `_service` 的 `url` 参数。

如果 `origin` 是 SSH 形式，扩展会自动转成 HTTPS，避免 OBS 服务端没有本机 SSH key 导致 `obs_scm` 展开失败：

```text
git@github.com:Leetfs/openRuyi.git
-> https://github.com/Leetfs/openRuyi.git
```

扩展也会在写 `_service` 前检查当前 Git 分支是否已经存在于远端；如果分支还没 push，会先提示你。

如果当前仓库没有 origin，请先在源码仓库里设置：

```bash
git remote add origin https://github.com/Leetfs/openRuyi.git
```

## 创建包

当本地 `.spec` 对应的包还没有在 OBS 上创建时，点击 `Create OBS Package`。

创建时会让你选择目标位置：

- 创建到自己的 home 项目：`home:用户名/包名`
- 使用包名创建一个 home 子项目：`home:用户名:包名/包名`
- 创建到已有 home 子项目：从 `home:用户名:*` 列表选择，或手动输入

创建流程会执行：

```text
osc rmkpac <project> <package>
osc init <project> <package>
osc update
write _service
osc addremove
osc commit -m "add _service for <package>" _service
```

本地 OBS 工作副本默认放在：

```text
.obs-packages/<project>/<package>
```

这个目录只用于 `_service`，不会把 `.osc` 写进你的源码目录。

创建时不会再询问包名、架构、分支、extract 路径或本地目录：

- 包名来自 spec 的 `Name:` 或 spec 文件名；`Name: python-%{srcname}` 这类写法会自动展开已定义的 `%global/%define` 宏
- 分支来自当前 Git 工作分支
- extract 来自 spec 上级目录相对 Git 根目录的路径
- OBS 本地工作副本自动放进 `.obs-packages`

## OBS 侧边栏

打开 `.spec` 后，点击左侧和文件、搜索平级的 `OBS` 图标，面板里会看到：

- `OBS Target`：当前 spec 绑定的 OBS project/package
- `Build Status`：可折叠状态组，自动刷新并显示所有 repository/arch 的构建状态
- `Create OBS Package`
- `Update _service`
- `Update RemoteAsset`：下载 spec 中的 HTTP(S) `Source` URL，计算 sha256，并刷新对应的 `#!RemoteAsset:` 行
- `Delete Package`：立即执行 `osc rdelete` 删除当前 OBS package
- `Rebuild Package`
- `Trigger Services`
- `Log Target`：从 OBS project metadata 读取 repository/arch 并选择日志目标，默认 `x86_64`
- `Open Output`
- `Stop Running Command`

默认每 3 秒刷新一次状态。可以点击 `Build Status` 手动刷新，也可以折叠/展开它下面的细分构建状态。状态列表始终查询并显示全部 OBS repository/arch，不会因为选择了某个 `Log Target` 而被过滤。

`Build Status` 下的每一条 `repository / arch` 都可以点击；点哪个目标，就把哪个目标的 build log 流式输出到 VSCode 自带 Output 面板。

创建包、重新构建和 Trigger Services 后，扩展会自动在 VSCode 自带 Output 面板里打开默认日志目标的 build log。默认架构是 `x86_64`，可以在左侧面板点击 `Log Target` 从 OBS 的 repositories/arches 列表里修改。

日志通过 OBS `_log?nostream=1&start=<offset>` 增量读取，有新内容就立即写入 Output 面板，不再依赖 `osc buildlog` 的长连接输出节奏。Output 面板的滚动由 VSCode 自身控制，扩展不会再使用单独的自定义 Webview。

如果没有手动设置 OBS build target/repository，扩展会从 `Build Status` 结果里自动推断。比如状态行里出现：

```text
amd64 x86_64 zxing-cpp ...
```

则自动使用 `amd64/x86_64` 打开日志。

## RemoteAsset sha256

点击 `Update RemoteAsset` 后，扩展会扫描当前 `.spec` 的 `Source`、`Source0`、`Source1` 等行。URL 中的 `%{version}`、`%{name}`、`%{srcname}` 等已定义宏会先展开，再下载远端文件并计算 sha256。

如果 `Source` 上一行已有 `#!RemoteAsset:`，会替换为新的：

```text
#!RemoteAsset:  sha256:<sha256>
Source0:        https://github.com/opencv/opencv/archive/%{version}/opencv-%{version}.tar.gz
```

如果没有，就会自动插入到对应 `Source` 行上方。多条 `Source0`、`Source1`、`Source2` 会逐条处理。

## 配置

通常用左侧面板配置即可。工作区 `.vscode/settings.json` 示例：

```json
{
  "obsService.apiUrl": "https://api.opensuse.org",
  "obsService.homeProject": "home:yourname",
  "obsService.defaultRepository": "openSUSE_Tumbleweed",
  "obsService.defaultArch": "x86_64",
  "obsService.logArch": "x86_64",
  "obsService.statusPollingEnabled": true,
  "obsService.statusRefreshIntervalSeconds": 3
}
```

这里的 `defaultRepository` 指 OBS 构建目标，不是 Git 仓库。状态会查询全部 build targets；日志目标可通过左侧 `Log Target` 选择，或者直接点击 `Build Status` 下的某条构建状态。

按 spec 的绑定会自动写进：

```json
{
  "obsService.specMappings": {
    "SPECS/perl-IO-Compress/perl-IO-Compress.spec": {
      "project": "home:yourname",
      "package": "perl-IO-Compress",
      "repository": "openSUSE_Tumbleweed",
      "arch": "x86_64",
      "packageDirectory": "/path/to/repo/.obs-packages/home_yourname/perl-IO-Compress",
      "homeProject": "home:yourname"
    }
  }
}
```

## 代码模块

`src` 目录按功能拆分，避免把扩展入口堆成单文件：

- `extension.js`：VSCode 扩展入口，只负责生命周期、命令注册、顶层命令编排、状态栏刷新和 context guard。
- `config.js`：读取/更新 `obsService.*` 配置，以及保存每个 spec 的 OBS mapping。
- `workspace.js`：识别当前 `.spec`、选择 spec、构建当前 spec 的运行上下文、计算默认 `.obs-packages` 工作目录。
- `tree.js`：OBS Activity Bar 侧边栏树视图，包括按钮项、Build Status 子项和点击日志入口。
- `spec.js`：RPM spec 文本解析，包含 `Name:` 包名推断、`%global/%define` 宏展开、`Source` 与 `#!RemoteAsset` 行的文本更新。
- `remote-assets.js`：`Update RemoteAsset` 命令实现，负责展开 Source URL、下载远端文件、计算 sha256 并回写 spec。
- `git.js`：Git remote URL 读取/归一化、当前分支读取、远端分支可用性检查、Git root 查询。
- `osc.js`：所有 `osc`/命令进程封装，包括普通命令执行、capture 命令、当前运行进程管理、停止命令、build log 流式读取、`osc` 参数展示和错误归一化。
- `packages.js`：OBS package 相关流程，包括 home project 选择、创建项目/包、初始化 OBS 工作副本、写入并提交 `_service`，以及 `_service`/OBS project XML 生成。
- `targets.js`：OBS repository/arch 目标选择和推断，包括 `Log Target`、从 project metadata/status 中推断默认日志目标，以及 OBS project metadata 的 build target 解析。

通常改 UI 入口看 `extension.js` 和 `tree.js`；改 spec 解析看 `spec.js`；改下载 hash 看 `remote-assets.js`；改 `osc` 行为或日志流看 `osc.js`；改创建包和 `_service` 流程看 `packages.js`。

## 安装

生成好的安装包在：

```text
outputs/vscode-obs-service-0.0.1.vsix
```

VSCode 命令面板执行：

```text
Extensions: Install from VSIX...
```

或者：

```bash
code --install-extension outputs/vscode-obs-service-0.0.1.vsix --force
```

## 重新打包

使用 npm 构建：

```bash
npm run build
```
