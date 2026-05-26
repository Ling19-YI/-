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

### 2. 获取 DeepSeek API Key（可选，用于AI答题）

1. 注册 [DeepSeek](https://platform.deepseek.com/)
2. 在 [API Keys](https://platform.deepseek.com/api_keys) 页面创建 Key
3. 启动时会提示输入 Key，留空则跳过答题

> DeepSeek 费用极低（约 ¥1/百万 token），一个课程的答题通常只需几分钱。

### 3. 启动

```bash
node launcher.js
```

按提示选择平台、输入账号密码即可。如果配置了 DeepSeek API Key，遇到答题会自动调用 AI 作答。

## 答题功能

遇到章节中的答题页面（选择题、判断题、填空题）时，自动调用 DeepSeek API 回答问题。

- **题型支持**: 单选、多选、判断、填空
- **答题流程**: 检测答题页 → 提取题目 → AI作答 → 自动点击选项 → 提交
- 未配置 API Key 时，答题节点会被跳过（不影响视频进度）
- API 调用失败时会自动跳过当前答题，继续后续章节

## 文件结构

```
mooc-helper/
├── launcher.js        ← 入口，选平台
├── index.ts          ← 超星学习通（含答题）
├── gd_video_auto.js  ← 杭州干部学习
├── login-ui.html    ← 超星登录界面
├── login-gd.html    ← 干部平台登录界面
├── data/             ← 各课程进度（自动）
└── credentials*.json ← 各平台账号（自动）
```

## 注意事项

- 账号密码仅本地保存，不上传
- DeepSeek API Key 仅内存保存，不写文件
- 进度在 `data/`，各平台凭证在 `credentials*.json`
- `node_modules/`、`data/`、`credentials*.json` 均已在 .gitignore