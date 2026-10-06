# 发布流程

本仓库的持续构建与发布由两个自包含的 workflow 承担，不依赖任何第三方 action。

| 文件 | 职责 |
|---|---|
| `.github/workflows/ci.yml` | 每次 push / PR：契约检查 + 构建一次发布包并留 artifact |
| `.github/workflows/release.yml` | 打 tag 或被手动触发时：构建并上传 Release 资产 |

两者都先跑 `scripts/verify-bundle.mjs`。它检查的是「装得上但什么都不加载」这类缺陷：`dsh.bundle.patch` 指向不存在的文件、`exports` 目标被改名、`files` 里的条目不存在、入口文件语法错误。这些缺陷在安装那一刻之前都是隐形的，所以门禁放在构建之前。

## 正式发布

```bash
# 1. 改 package.json 的 version —— release 会拿 tag 与它核对
# 2. 提交并推送
git commit -am "chore: release v1.2.3"
git push origin main

# 3. 打 tag 并推送，这一步才触发发布
git tag v1.2.3
git push origin v1.2.3
```

tag 与 `package.json` 的 version 不一致时 workflow **直接失败**，不会发出版本漂移的包；tag 打错提交也一样会失败，而不是发一个内容不对的 Release。

## 手动触发

`Actions → Release → Run workflow`，默认勾选 draft。

- 它用 `package.json` 的 version 推出 tag `v<version>`，你不需要先在本地打 tag。
- **默认发成草稿**：草稿对外不可见，确认无误后在 Release 页面点 `Publish release`。
- 同一个 tag 再跑一次会**替换资产**（`--clobber`），不会产生第二个 Release。

## 资产内容

`<name>-<version>.zip` + `SHA256SUMS.txt`：

- 用 `git archive` 打包**该提交的完整仓库树**，所以 `node_modules/`、`.git/`、编辑器与运行期本机状态天然不在里面——不需要手写排除规则，也不可能混入本机专有文件。
- 解压后是 `<name>-<version>/` 目录，内容就是一个标准 DSH bundle 包（`package.json` + `cordis.patch.yml` + 入口文件）。本机 profile 用 `link:` 指向本地检出目录安装，解压出来的目录同理。
- `SHA256SUMS.txt` 的用途是校验**下载到的那一份没坏**。

### 关于「可复现」

内容是确定的：同一个 tag 永远打出同一棵树。但 **zip 字节不保证跨机一致**——容器里会写入打包工具的 deflate 实现信息，实测本机预演与 CI 产物的 zip 同尺寸、sha256 不同。所以不要把两台机器构建出的 sha256 拿来互相比对，也不要用它做「构建是否被篡改」的判据。

## 本地预演

CI 上跑的就是这几条命令，本地可以原样复现：

```bash
node scripts/verify-bundle.mjs
mkdir -p dist
NAME=$(node -p 'require("./package.json").name'); VERSION=$(node -p 'require("./package.json").version')
git archive --format=zip --prefix="$NAME-$VERSION/" -o "dist/$NAME-$VERSION.zip" HEAD
# 解压后再验一次：证明的是「发布出去的那份资产」完整，而不是检出目录完整
```
