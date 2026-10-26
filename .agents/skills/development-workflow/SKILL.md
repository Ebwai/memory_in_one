---
name: "development-workflow"
description: "项目开发流程编排。当用户要从需求开始开发功能、处理新需求/产品变更/Architecture 或 TDD 变更时使用本 Skill。"
metadata:
  "version": "1.0.0"
---

# development-workflow

## 目标与边界

只执行一个职责：

> **编排一个需求从产品定义、设计、实现到闭环的顺序，并在正确时间调用对应 Skill / Rule。**

使用以下职责分工：

```text
docs-generator
→ 创建 / 更新项目文档

docs-generator/references/*
→ 每种文档具体写法

codebase-index
→ 代码导航与真实实现定位

.claude/rules/code-local-constraints.md
→ Coding 时的局部约束与 Executable Constraint 规则
```

---

## 核心开发模型

遵循：

- **需求理解：Top-down**
- **能力实现：Bottom-up**
- **Architecture：编码前建立系统坐标系**
- **TDD：需求进入实现时 JIT**
- **优先复用已实现基础能力**
- **默认一个需求完整闭环后再进入下一个**

整体流程：

```text
用户需求
→ 产品定义
→ Architecture Baseline
→ 每个概念/机制按照优先级逐项实现（优先级存在于plan中，如果没有的话，结合全部需求，遵循Bottom-up的原则给出一个所有拆解出的概念/机制实现的优先级排序，使得优先级排在后面的概念/机制可以用上优先级排在前面的概念/机制，从而提高开发效率。换句话说就是优先基础性和复用价值更高的概念/机制实现）
```

---

## 新项目初始化

### 1. 建立 MRD

MRD记录的是项目的出发点，也就是最核心，最开始的那些底层思维，项目的核心亮点。

```text
→ 调用docs-generator skills
→ 按 MRD template 完成 MRD文档的编写
→ 用户确认
```

MRD 的具体写法完全交给 `docs-generator` 及其 reference。

### 2. 建立 PRD Baseline

MRD 确认后：

```text
→ 调用docs-generator skills
→ 按 PRD template 完成 Requirement Discovery
→ 得到 PRD baseline
→ 用户确认
```

### 3. 建立 Architecture Baseline

PRD baseline 确认后：

```text
→ docs-generator
→ 创建 / 更新 Architecture
→ 用户确认
```

Architecture baseline 完成后：

> **不要一次性预写完整项目 TDD。**

按照优先级进入一个一个概念/机制的交付循环。

---

## 概念/机制交付循环

默认一次推进一个 PRD 中拆解骨架中的概念/机制。

### 1. 选择下一个概念/机制

从 PRD 开发优先级队列选择下一个开发实现

### 2. 建立真实实现上下文

调用：

```text
codebase-index
```

获得：

- PRD 语义；
- Architecture 责任区域；
- Existing TDD；
- 主要实现位置；
- 相关 Schema / tests；
- 必须共同阅读的实现点；
- 可复用已有能力；
- 文档 / 实现不一致或其他缺口。


### 3. 判断是否需要 JIT TDD

基于真实实现上下文判断是否出现新的跨实现点技术设计。

出现以下情况时，通常需要创建 / 更新 JIT TDD：

- 多个实现点共同完成一个行为；
- 新增 / 改变稳定契约；
- 跨组件状态流转；
- 一致性 / 并发 / 幂等语义；
- 关键失败恢复；
- 多实现点技术不变量；
- 单一局部代码无法恢复的重要技术决策。

需要时：

```text
→ docs-generator
→ 创建 / 更新当前需求相关 JIT TDD
```

以下情况可不新增 TDD：

- Existing TDD 已完整覆盖；
- 仅涉及局部实现；
- 没有新的契约、流程、状态或其他跨实现点语义。

不要为了形式创建 TDD。

### 4. Coding

进入 Coding：

- 使用 `codebase-index` 已定位的真实上下文；
- 优先复用已有能力；
- 遵循 `.claude/rules/code-local-constraints.md`。


### 5. 验证

实现后确认：

- 当前概念/机制产品验收通过；
- 必要 tests 通过；
- 必要 Executable Constraints 已落实；
- 再次阅读本次开发对应的PRD的概念/机制文档，确认实现的功能是符合其需求定义的
- 没有遗漏同一实现链上的必要修改。

### 6. 路由实现后的文档影响

根据真实变化选择下一步。

#### 产品语义变化

包括：

- 产品验收变化；
- 确定性业务规则变化；
- Concept / Mechanism 含义变化；
- 出现新的产品能力。

执行：

```text
→ docs-generator 更新 PRD
```

必要时重新进入用户需求对齐。

#### Architecture 变化

包括：

- 模块职责变化；
- 依赖方向变化；
- 数据 / 状态 / 副作用所有权变化；
- 跨模块边界变化。

执行：

```text
→ docs-generator 更新 Architecture
```

#### TDD 变化

包括：

- 跨实现点行为变化；
- 契约变化；
- 状态生命周期变化；
- 一致性 / 并发 / 幂等 / 恢复语义变化。

执行：

```text
→ docs-generator 更新 TDD
```

#### 纯局部变化

只维护：

- Code-local Constraint；
- Executable Constraints；
- tests。

不要为了纯局部变化创建更高层文档。

### 7. As-built 对齐

本需求更新过 TDD / Architecture 时：

```text
→ docs-generator
```

要求最终文档：

- 反映实际完成的实现；
- 删除被推翻的预想设计；
- 更新真实实现锚点。

具体写法交给对应 reference template。

然后再进入下一个原子需求。

---

## 新需求进入已有项目

### 1. 更新产品需求

新增 / 修改产品需求/能力时：

```text
→ docs-generator
→ 更新 PRD
```

让 PRD template 自己完成：

- 从新需求第一层开始逐层拆解；
- 优先复用已有 Concept / Mechanism；
- （如适用）更新 DAG；
- （如适用）更新之前设计/已实现的概念/机制；
- （如适用）更新依赖 / 复用；
- 重新检查一遍开发优先级队列是不是需要更新

不要在本 Skill 重复其 Requirement Discovery 细节。

### 2. 检查 Architecture

PRD 更新后判断：

- 若新需求完全落在已有 Architecture 边界内，Architecture 不改；
- 若出现新职责、新依赖、新所有权或新跨模块边界，则调用 `docs-generator` 更新 Architecture。

### 3. 按新队列继续交付

不要为新需求批量预写所有 TDD。

重新按 PRD 开发优先级队列逐项执行：

```text
原子需求
→ codebase-index
→ 按需 JIT TDD
→ Coding
→ 验证
→ 文档同步
→ 闭环
```

---

## 已有项目中的其他修改

### 纯机械修改

文件 / 函数明确、无业务语义、且不影响跨实现点行为时，直接 Coding。

### 局部 Bug 但涉及业务行为

先调用：

```text
codebase-index
```

若最终确认只是局部修复：

```text
Coding
→ Code-local Rule
→ tests
→ 完成
```

若发现上层文档需要变化，再调用 `docs-generator`。

### 已知 Architecture / TDD 设计更新

用户明确要求修改 Architecture / TDD 时：

```text
development-workflow
→ docs-generator
```

若写入需要真实代码证据，则先：

```text
codebase-index
→ docs-generator
```

---

## 文档与代码不一致

`codebase-index` 报告：

```text
Normative / Target Design
≠
Current Implementation
```

时选择处理路径：

- **已确认设计是目标** → 修改代码使其符合设计；
- **用户明确确认当前实现是新目标** → 调用 `docs-generator` 更新对应文档；
- **无法判断且涉及 PRD / Architecture / TDD 语义** → 请求用户确认。

不要静默选择任一侧。

---

## 调用关系

```text
development-workflow
│
├─ 需要文档
│  └─ docs-generator
│     └─ 按需读取 references/*
│
├─ 需要真实实现上下文
│  └─ codebase-index
│
├─ 需要写 Architecture / TDD block
│  └─ docs-generator
│
└─ 进入 Coding
   └─ code-local-constraints Rule
```
