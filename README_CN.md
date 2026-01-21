# AI Organiser: Obsidian 智能笔记组织插件

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![中文](https://img.shields.io/badge/lang-中文-red.svg)](README_CN.md)

![AI Organiser](https://img.shields.io/badge/Obsidian-AI%20Organiser-purple)
![Obsidian Compatibility](https://img.shields.io/badge/Obsidian-v1.4.0+-blue)

> 一款功能全面的 Obsidian AI 插件，帮助你组织、标记、总结和增强笔记。支持 13+ 云端服务和 5+ 本地 LLM 选项。

## 功能特性

### 智能标签系统
- **基于分类法的标签** - 可自定义主题和学科
- **3 层层级标签** (例如：`科学/生物学/遗传学`)
- **多种标签模式**：生成新标签、匹配已有标签、混合模式或自定义
- **批量操作** - 支持文件夹或整个仓库
- **标签网络可视化** - D3.js 交互式图表

### 内容总结
- **网页总结** - 保留链接的文章摘要
- **PDF 总结** - 原生多模态支持 (Claude/Gemini)
- **YouTube 总结** - 通过字幕提取
- **音频总结** - 转录 + 摘要 (MP3, WAV, M4A, OGG)
- **5 种内置人设** - 学生、高管、休闲、研究员、技术
- **转录稿保存** - 完整转录稿与元数据一同保存

### 闪卡导出
- **两种卡片样式**：
  - 标准问答 - 传统的问题和答案格式
  - 选择题 - 考试风格，包含 A/B/C/D 选项和解释
- **两种导出格式**：
  - Anki - 带 MathJax 数学符号的 CSV
  - Brainscape - 纯文本数学的 CSV
- **可选上下文** - 用于聚焦卡片生成

### 智能笔记功能
- **AI 改进笔记** - 可选人设的上下文感知增强
- **查找相关资源** - YouTube 和网页搜索集成
- **生成 Mermaid 图表** - 流程图、时序图、类图、思维导图、时间线、ER 图、状态图
- **文本高亮** - 多种颜色选项

### 翻译
- 翻译整篇笔记或选中内容
- 保留 Markdown 格式
- 支持所有主要语言

### 实用工具
- **命令选择器** - 统一的 27+ 命令访问界面
- **标签网络** - 标签关系的交互式可视化
- **收集标签** - 将仓库中所有标签导出到文件

## 安装

### 从 Obsidian 社区插件安装（推荐）
1. 打开 Obsidian 设置
2. 导航到「社区插件」
3. 搜索「AI Organiser」
4. 点击「安装」，然后「启用」

### 手动安装
1. 从 [GitHub](https://github.com/Lbstrydom/ai-organiser) 下载最新版本
2. 解压到 `.obsidian/plugins/ai-organiser/`
3. 重启 Obsidian 并启用插件

## 快速开始

1. **配置 AI 服务提供商**：
   - 设置 → AI Organiser → LLM 设置
   - 选择本地 (Ollama, LM Studio) 或云端 (OpenAI, Claude, Gemini 等)
   - 输入端点 URL 和 API 密钥

2. **访问命令**：
   - 点击功能区的闪光图标
   - 或使用命令面板 (Ctrl/Cmd+P)

3. **开始组织**：
   - 为笔记生成标签
   - 总结网页内容
   - 创建闪卡
   - 使用 AI 改进笔记

## 支持的 LLM 提供商

### 云端服务 (13 个适配器)
| 提供商 | 标签 | 总结 | PDF | 音频 |
|--------|------|------|-----|------|
| Claude | 支持 | 支持 | 支持 (原生) | 通过 OpenAI |
| OpenAI | 支持 | 支持 | 不支持 | 支持 (Whisper) |
| Gemini | 支持 | 支持 | 支持 (原生) | 通过 OpenAI |
| Groq | 支持 | 支持 | 不支持 | 支持 (Whisper) |
| DeepSeek | 支持 | 支持 | 不支持 | - |
| OpenRouter | 支持 | 支持 | 视情况 | - |
| AWS Bedrock | 支持 | 支持 | 视情况 | - |
| Vertex AI | 支持 | 支持 | 支持 | - |
| Mistral | 支持 | 支持 | 不支持 | - |
| Cohere | 支持 | 支持 | 不支持 | - |
| Grok | 支持 | 支持 | 不支持 | - |
| 阿里云 | 支持 | 支持 | 不支持 | - |
| OpenAI 兼容 | 支持 | 支持 | 不支持 | - |

### 本地提供商
- Ollama
- LM Studio
- LocalAI
- Jan
- KoboldCpp

## 配置

所有插件文件存储在可配置的文件夹中（默认：`AI-Organiser/`）：

```
AI-Organiser/
├── Config/                    # 用户可编辑的配置
│   ├── taxonomy.md            # 标签的主题和学科
│   ├── excluded-tags.md       # 排除的标签
│   ├── personas.md            # AI 写作人设
│   └── summary-personas.md    # 总结风格人设
├── Transcripts/               # 音频/YouTube 转录稿
└── Flashcards/                # 导出的闪卡文件
```

### 主要设置

- **LLM 设置** - 提供商、API 密钥、模型
- **标签设置** - 最大标签数、语言、分类法
- **总结设置** - 长度、语言、转录稿保存
- **界面设置** - 语言（中文/英文）

## 语言支持

### 界面
- English (英文)
- 简体中文

### 内容生成
标签和摘要可以用 LLM 支持的任何语言生成。

## 命令

| 分类 | 命令 |
|------|------|
| 标签 | 生成标签（笔记/文件夹/仓库）、清除标签、分配预定义标签 |
| 总结 | 从 URL、PDF、YouTube、音频 |
| 智能笔记 | 改进笔记、查找资源、生成图表 |
| 闪卡 | 导出闪卡 |
| 翻译 | 翻译笔记、翻译选中内容 |
| 工具 | 命令选择器、标签网络、收集标签 |

## 开发

```bash
# 安装依赖
npm install

# 开发构建（监视模式）
npm run dev

# 生产构建
npm run build

# 运行测试
npm test
```

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 贡献

欢迎贡献！请在 [GitHub](https://github.com/Lbstrydom/ai-organiser) 提交问题和拉取请求。

## 支持

- [GitHub Issues](https://github.com/Lbstrydom/ai-organiser/issues)
- [Buy Me a Coffee](https://buymeacoffee.com/lbstrydom)

## 致谢

感谢所有贡献者和 Obsidian 社区！
