# 户型装修设计

中文 | [English](README.en.md)

户型装修设计工具：在 2D 平面图上摆放家具、拆改墙体、测量尺寸，一键切换到 Three.js 3D 场景，可以鸟瞰，也可以第一人称漫游。网页以 `index.html` 为入口，无需构建；本地保存无需后台，可选的跨设备同步使用 Supabase。

## 在线使用与部署

- 在线地址：<https://wu-zzz.github.io/floorplan-3d/>
- 本仓库 fork 自 [wy51ai/floorplan-3d](https://github.com/wy51ai/floorplan-3d)，保留原项目 MIT 许可，加入自家户型与四卧方案。
- 推送到 `master` 后，GitHub Actions 自动发布到 GitHub Pages；也可以在 Actions 中手动运行 `Deploy GitHub Pages`。
- 发布内容为网页、户型脚本、`sync-*.js` / `sync-ui.css`、`LICENSE`，以及页面引用的两份 `assets` 参考资料。网站及其默认户型资料公开可访问，云端修改由账号隔离。
- 设计修改始终保存在当前浏览器；配置云端后，同一邮箱登录的设备会自动同步。本地旧方案请先导出 JSON，再到在线页面导入；重要版本请保留 JSON 备份。
- 3D 使用 jsDelivr 提供的 Three.js，需要浏览器能够连接该服务。

`scripts/` 与 `layout-proposal.json` 用于本地维护，不参与网页运行。重新从 CAD 提取几何需要本地的 `../CAD核对/转换文件/户型.dxf`，以及用于来源校验的 `../CAD核对/原始文件/2栋1户型.dwg`；部署使用已生成的 JavaScript，不需要原始 CAD 或这些脚本的依赖。历史导出文件不随网站发布。

## 启用云端保存

未配置 `sync-config.js` 时仅本地保存，不能跨设备同步。云端启用步骤：

1. 为本项目准备独立的 Supabase 项目，应用 `supabase/migrations/202610230001_floorplan_sync.sql` 一次。
2. 在 Auth 的 URL Configuration 中，把 Site URL 和允许跳转的网址设为 `https://wu-zzz.github.io/floorplan-3d/`。启用邮箱登录，保留默认 Magic Link 邮件模板。
3. 确认登录邮件可以送达。Supabase 默认邮件服务只面向项目团队邮箱且有发送限制；其他邮箱需要配置自有 SMTP。见 [官方邮件服务说明](https://supabase.com/docs/guides/auth/auth-smtp)。
4. 在 `sync-config.js` 填入项目 HTTPS URL 和 `sb_publishable_` 开头的公开 key，再发布。禁止使用 secret key、service-role key 或数据库密码。
5. 电脑、手机分别点击“云端同步”，使用同一邮箱，在各自设备打开收到的登录链接。

修改停止约 0.8 秒后自动上传；网页在前台时每 5 秒检查更新，切回页面或恢复联网时立即检查。关闭网页期间不能后台同步，未上传内容会保留为本机草稿。首次打开的新设备先下载云端；两边都有修改时需选择版本，替换前保留最近 5 份本机备份。同一浏览器不同标签页各有待同步草稿，可在同步面板下载，再通过“导入方案”恢复。

云端使用整份方案 JSON 和服务器版本号，原子比较版本后写入；冲突不会自动合并家具位置。账号只可读取自己的方案，写入仅经过受保护的 `save_floorplan` 函数。视角、语言及面板位置不同步。

开发校验：`npm ci --ignore-scripts` 后运行 `npm test`。数据库测试在本地 PGlite 执行迁移及账号权限，属于本地验证；上线还需验证真实邮箱登录、两台设备读写、断网恢复及冲突处理。

## 功能

**2D 平面布置**
- 按原始户型 1:60 / 1:100 比例显示，尺寸单位 mm
- 从左侧家具库拖入 60 余种家具家电（卧室、客厅、餐厨、卫浴、家电、书房休闲）
- 拖动移动、旋转（Shift 自由角度）、调整尺寸，贴墙自动吸附
- 测量工具（靠近墙面自动吸附，Shift 锁定水平 / 垂直）
- 拆改非承重墙，承重墙单独标示
- 图层开关：尺寸标注、房间名、家具、网格、承重墙

**3D 场景**
- 鸟瞰、斜视、俯视多种视角，点击房间列表可飞到对应房间
- 漫游模式：桌面端 WASD + 鼠标，触屏设备用虚拟摇杆，可以点门开关
- 全高墙 / 剖切墙切换，日照时间滑块，夜景灯光
- 精细家具模型：柜门分缝与拉手、软包床头、带环境反射的金属与陶瓷材质等
- 在 3D 中也能选中、拖动家具，与 2D 方案实时同步

**方案与统计**
- 房间面积与套内使用面积自动统计
- 为每个房间更换地面材料（木地板、地砖、大理石、水磨石、地毯等），按面积加 5% 损耗估算造价
- 撤销 / 重做，方案自动保存在浏览器本地
- 中文 / English 界面切换（顶栏右侧按钮，默认中文，选择会记住）
- 导出 PNG 图片，导出 / 导入方案 JSON

## 快速开始

```bash
git clone <仓库地址>
cd <仓库目录>
```

然后直接用浏览器打开 `index.html`。也可以起一个本地静态服务器：

```bash
python3 -m http.server 8000
# 访问 http://localhost:8000
```

> Three.js 通过 jsDelivr CDN 加载，首次打开 3D 场景需要联网。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `T` | 切换 2D / 3D |
| `V` / `M` / `X` | 选择 / 测量 / 拆改墙体 |
| `R` / `Shift+R` | 选中家具顺时针 / 逆时针旋转 90° |
| `Delete` / `Backspace` | 删除选中家具 |
| `Ctrl/⌘ + D` | 复制选中家具 |
| `Ctrl/⌘ + Z`，`Ctrl/⌘ + Shift + Z` | 撤销，重做 |
| `F` | 适应窗口 |
| `+` / `-` | 放大 / 缩小 |
| `[` / `]` | 展开 / 收起左侧家具库、右侧面板 |
| `Shift + F` | 全屏 |
| `Esc` | 取消当前操作 |
| 漫游：`WASD` / 方向键，`Shift`，`E` | 移动，快走，开关门 |

## 技术栈

- 原生 HTML / CSS / JavaScript，无框架、无构建步骤
- 2D 平面图用 SVG 绘制
- 3D 场景用 [Three.js](https://threejs.org/) r160（OrbitControls、PointerLockControls、RoundedBoxGeometry、RoomEnvironment、CSS2DRenderer）
- 数据保存在 `localStorage`

## 自定义户型

当前版本的户型数据在 `cad-geometry.js`、`photo-appearance.js` 和 `home-plan.js` 中；家具库、材料及交互逻辑在 `index.html` 中：

- `ROOMS`：房间多边形、名称、默认地面材料
- `WALLS` / `WINS`：墙体与窗洞
- `MATS`：地面材料名称与单价
- `LIB`：家具库（类型、名称、默认尺寸、颜色）
- `buildFurniture()`：各类家具的 3D 模型

改这些数据就能换成自己的户型。

## 社交媒体

- X（Twitter）：[@akokoi1](https://x.com/akokoi1)

## 许可协议

[MIT](LICENSE)
