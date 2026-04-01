# Content Creator Photon AI-powered content research and publishing workflow. Demonstrates Photon composition

depends on web.photon and social-formatter.photon Workflow: 1. Research: Search web for topics, fetch and summarize content 2. Write: AI generates article/post from research 3. Format: Convert to platform-specific formats 4. Publish: Post to selected social media (manual for now)

> **4 tools** · Workflow Photon · v1.18.0 · MIT

**Platform Features:** `generator` `elicitation` `streaming`

## ⚙️ Configuration


| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `CONTENT_CREATOR_PHOTON_APIKEY` | No | string | No description available |
| `CONTENT_CREATOR_PHOTON_FORMATTER` | No | any | No description available |





## 🔧 Tools


### `research` ⚡

Research a topic by searching the web and summarizing findings


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | Yes | - Topic to research |
| `depth` | number | No | - How many sources to analyze |





---


### `generate` ⚡

Generate content from research results


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `research` | ResearchResult | Yes | - Research results from research() |
| `style` | 'professional' | 'casual' | 'technical' | No | - Content style: 'professional', 'casual', 'technical' |
| `length` | 'short' | 'medium' | 'long' | No | - Target length: 'short' (tweet), 'medium' (linkedin), 'long' (blog) |





---


### `formatContent` ⚡

Format generated content for multiple platforms





---


### `createContent` ⚡

Complete workflow: Research → Generate → Format. Interactive workflow that guides user through content creation





---





## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph content_creator["📦 Content Creator"]
        START([▶ Start])
        N0[📢 Researching: ${topic}]
        START --> N0
        N1[⏳ progress]
        N0 --> N1
        N2[⏳ progress]
        N1 --> N2
        N3[⏳ progress]
        N2 --> N3
        N4[⏳ progress]
        N3 --> N4
        N5[⏳ progress]
        N4 --> N5
        N6[📢 Generating content...]
        N5 --> N6
        N7{✏️ text}
        N6 --> N7
        N8[⏳ progress]
        N7 --> N8
        N9[⏳ progress]
        N8 --> N9
        N10[⏳ progress]
        N9 --> N10
        N11[📢 Formatting for platforms...]
        N10 --> N11
        N12[⏳ progress]
        N11 --> N12
        N13[🎉 Content formatted!]
        N12 --> N13
        N14[📢 Starting content creation f...]
        N13 --> N14
        N15[📢 📚 Phase 1: Research]
        N14 --> N15
        N16[📝 log]
        N15 --> N16
        N17{🙋 confirm}
        N16 --> N17
        N18([❌ Cancelled])
        N17 -->|No| N18
        N17 -->|Yes| N19
        N19[Continue]
        N20{❓ form}
        N19 --> N20
        N21[📢 ✍️ Phase 2: Generate]
        N20 --> N21
        N22[📢 🎨 Phase 3: Format]
        N21 --> N22
        N23[🎉 Content ready for publishing!]
        N22 --> N23
        SUCCESS([✅ Success])
        N23 --> SUCCESS
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add content-creator

# Get MCP config for your client
photon info content-creator --mcp
```

## 📦 Dependencies


```
@portel/photon-core@latest, @anthropic-ai/sdk@latest
```

---

MIT · v1.18.0
