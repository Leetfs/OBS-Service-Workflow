# OBS Service Workflow for VS Code

一个围绕当前 `.spec` 文件工作的轻量 OBS/Open Build Service 扩展。

打开 `.spec` 后，VSCode 左侧 Activity Bar 会出现独立的 `OBS` 图标，点进去就是 `OBS Workflow` 面板。现在只保留核心能力：

- 创建 OBS 包
- 生成并提交 `_service`
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

- 包名来自 spec 的 `Name:` 或 spec 文件名
- 分支来自当前 Git 工作分支
- extract 来自 spec 上级目录相对 Git 根目录的路径
- OBS 本地工作副本自动放进 `.obs-packages`

## OBS 侧边栏

打开 `.spec` 后，点击左侧和文件、搜索平级的 `OBS` 图标，面板里会看到：

- `OBS Target`：当前 spec 绑定的 OBS project/package
- `Build Status`：可折叠状态组，自动刷新并显示所有 repository/arch 的构建状态
- `Create OBS Package`
- `Update _service`
- `Delete Package`：立即执行 `osc rdelete` 删除当前 OBS package
- `Rebuild Package`
- `Trigger Services`
- `Log Target`：从 OBS project metadata 读取 repository/arch 并选择日志目标，默认 `x86_64`
- `Open Output`
- `Stop Running Command`

默认每 3 秒刷新一次状态。可以点击 `Build Status` 手动刷新，也可以折叠/展开它下面的细分构建状态。状态列表始终查询并显示全部 OBS repository/arch，不会因为选择了某个 `Log Target` 而被过滤。

`Build Status` 下的每一条 `repository / arch` 都可以点击；点哪个目标，就把哪个目标的 build log 流式输出到 VSCode 自带 Output 面板。

创建包和重新构建后，扩展会自动在 VSCode 自带 Output 面板里打开默认日志目标的 build log。默认架构是 `x86_64`，可以在左侧面板点击 `Log Target` 从 OBS 的 repositories/arches 列表里修改。

日志通过 OBS `_log?nostream=1&start=<offset>` 增量读取，有新内容就立即写入 Output 面板，不再依赖 `osc buildlog` 的长连接输出节奏。Output 面板的滚动由 VSCode 自身控制，扩展不会再使用单独的自定义 Webview。

如果没有手动设置 OBS build target/repository，扩展会从 `Build Status` 结果里自动推断。比如状态行里出现：

```text
amd64 x86_64 zxing-cpp ...
```

则自动使用 `amd64/x86_64` 打开日志。

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
