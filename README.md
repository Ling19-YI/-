# 刷课助手

同时支持两个平台，首次配置后直接运行。

## 支持平台

| 平台 | 课程 |
|------|------|
| 超星学习通 | 进阶英语读写、C++、高数等 |
| 杭州干部学习平台 | 国防教育视频 |

## 首次使用

### 1. 安装依赖

```bash
npm install
npx playwright install chromium --with-deps
```

### 2. 启动

```bash
node launcher.js
```

按提示选择平台、输入账号密码即可。

## 文件结构

```
mooc-helper/
├── launcher.js        ← 入口，选平台
├── index.ts          ← 超星学习通
├── gd_video_auto.js  ← 杭州干部学习
├── login-ui.html    ← 超星登录界面
├── login-gd.html    ← 干部平台登录界面
├── data/             ← 各课程进度（自动）
└── credentials*.json ← 各平台账号（自动）
```

## 注意事项

- 账号密码仅本地保存，不上传
- 进度在 `data/`，各平台凭证在 `credentials*.json`
- `node_modules/`、`data/`、`credentials*.json` 均已在 .gitignore