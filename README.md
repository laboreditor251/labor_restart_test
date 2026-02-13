# 重生之我还是打工人

以劳动者处境为题的互动叙事新闻。读者在多分支现场中做选择，体验现实约束、风险与后果，并可重复重开对比不同路径。

## 技术栈
- Nginx 静态托管
- HTML + Alpine.js（CDN）
- Tailwind CSS（CDN）
- JSON 故事数据（`assets/story.json`）
- 原生 Web Audio（按钮音效）+ `<audio>` BGM

## 项目结构
```text
.
├── index.html
├── assets
│   ├── app.js
│   ├── styles.css
│   ├── story.json
│   ├── images/
│   └── audio/
├── STORY_NODES_GUIDE.md
├── nginx/
└── README.md
```

## 本地运行
```bash
python3 -m http.server 8080
```
访问：`http://localhost:8080`

## 使用 Nginx 运行
```bash
nginx -c /path/to/project/nginx/nginx.conf
```
访问：`http://localhost:8080`

## 交互流程（当前实现）
1. 首页：封面图 + 导语 +「开始重生」
2. 第二页：Trigger Warning +「我同意，进入故事」
3. 正文：节点文本/配图 + 选项推进
4. 结局页：结局卡片（结局摘要 + 节点正文）+「重启人生」

说明：如果用户已达成过结局，从结局页重启会跳过 Trigger Warning。

## 故事数据格式
故事入口与节点都在 `assets/story.json`：
- 顶层：`title`、`start`、`initial_state`、`intro`、`trigger_warning`、`nodes`
- 普通节点：`text`、`choices`、可选 `image`
- 结局节点：`ending`（`title/text/type`）+ `text`
- 自动分流：`auto_routes`

### 随机写法
在 `effects` 里写：
- `"some_roll": "rand(0,1)"`

再在 `auto_routes` 里按条件分流：
- `"condition": "some_roll == 0"`

## 主要功能
- 条件分支与状态系统（数字/布尔/字符串）
- 随机事件分流（`rand(min,max)`）
- 返回、重启、历史记录
- Debug 面板（按节点 ID 跳转）
- BGM 开关与按钮点击音效
- 节点图片渲染（`image` 字段）
- 基础 SEO 元信息（description、OG、Twitter、JSON-LD）

## 内容编辑说明
- 节点写法请参考：`STORY_NODES_GUIDE.md`
- 图片建议存放在：`assets/images/`
- 节点图片路径建议使用相对路径：
  - `"image": "./assets/images/xxx.jpg"`
- Google Search Console 提交站点地图
