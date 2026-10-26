---
name: "docs-generator"
description: "项目文档创建、补全、修改与同步。凡需要生成或更新 MRD、PRD、Architecture、TDD，或需要判断一条需求/规则/设计信息应写入哪一层项目文档时，必须使用本 Skill。只负责文档路由、按对应 reference template 写入和增量维护；文档具体写法按需读取 references/mrd-template.md、prd-template.md、architecture-template.md、tdd-template.md。不得承担开发流程编排、代码仓库导航或 Code-local Constraint 写法。"
metadata:
  "version": "1.0.0"
---

# docs-generator

## 目标

> **判断应该创建 / 更新哪一种项目文档，并读取该文档对应的 reference template 完成写入。**

把以下 reference 作为每种文档**具体写法的唯一规范来源**，里面包括每类文档的书写要求和模板：

| 文档 | 必须按需读取 |
|---|---|
| MRD | `references/mrd-template.md` |
| PRD | `references/prd-template.md` |
| Architecture | `references/architecture-template.md` |
| TDD | `references/tdd-template.md` |

---

## 文档路由

按信息作用域选择文档：

```text
为什么做
→ MRD

产品应该表现为什么
→ PRD

系统由谁负责、如何分边界
→ Architecture

多个实现点怎样共同成立
→ TDD

单模型 / 类 / 函数 / 分支局部约束
→ Code-local

机器自动保证
→ Executable Constraint
```

### MRD

用户设计这个软件的初衷，以及核心的设计理念和技术实现哲学和思想

写入前读取：

```text
references/mrd-template.md
```

### PRD

处理用户需求、按照要求逐层拆解形成PRD完整骨架图，创建功能包（Concept / Mechanism）、以及其确定性业务规则、交互、边界 / 异常、产品依赖 / 复用

写入或更新需求的时候前必须读取并严格遵守其中要求：

```text
references/prd-template.md
```

### Architecture

处理模块 / 目录、职责、依赖、所有权、跨模块边界、架构级约束、技术选型和非功能约束。

写入前读取：

```text
references/architecture-template.md
```

Architecture 的组织、职责、依赖、所有权、架构约束和 PRD 锚点等具体写法，以该 template 为准。

### TDD

处理既定 Architecture 边界内的关键契约、实现锚点、跨实现点流程、状态 / 数据语义、一致性 / 并发 / 幂等、失败恢复、模块级技术不变量和重要技术决策。

写入前读取：

```text
references/tdd-template.md
```

TDD 的 JIT 生命周期、导航类 / 细节类 block、具体章节及与 Code-local 的边界，以该 template 为准。

### Code-local / Executable

若信息属于单模型、类、函数或分支局部约束：

- 不创建新的 Markdown 规格层；
- 遵循 `.claude/rules/code-local-constraints.md`。

若规则可机器强制，则落到相应 Executable Constraint。


---

## 写入原则

### 增量更新已有文档

文档已存在时：
- 阅读对应文档类型的template获取对应文档的书写要求
- 只修改真正受影响的章节；

### 保持层级输入关系

使用以下语义输入关系：

- PRD 基于已确认产品方向；
- Architecture 基于已确认 PRD；
- TDD 基于已确认 Architecture + 相关 PRD 语义 + 当前真实实现上下文。

只维护该关系，不决定这些步骤何时发生；调用时机由 `development-workflow` 负责。

### 不虚构实现事实

不要为了文档完整虚构：

- 代码路径；
- 字段；
- Schema；
- 参数；
- 配置值；
- 尚未确认的技术设计。
---

## 信息来源

### 新项目

使用：

- MRD：用户输入或者再开发过程中的一些精华思想提炼
- PRD：已确认上层产品方向、用户需求、PRD Requirement Discovery 中用户确认的内容；
- Architecture：已确认 PRD、用户明确的技术 / 环境约束；
- TDD：已确认 Architecture、相关 PRD、当前实现上下文、已确认技术决策。

### 已有项目

若文档更新依赖真实代码事实，阅读对应的template获取对应文档的书写要求吗，并使用调用方通过 `codebase-index` 获取的实现导航上下文。

---

## 文档与代码不一致

调用方指出：

```text
Normative / Target Design
≠
Current Implementation
```

时：

1. 不静默覆盖任一侧；
2. 在写入前明确当前目标是：
   - 修正文档以反映已确认设计；或
   - 修改规范设计目标；
3. 若 PRD / Architecture / TDD 的规范语义本身不明确，要求用户确认。

---

## 输出位置

默认维护：

```text
docs/MRD.md
docs/PRD.md
docs/Architecture.md
docs/TDD.md
```

Architecture / TDD 的递归 leaf 位置由 block-sync 体系决定。

不要额外创建：

```text
constraints.md
business-rules.md
implementation-notes.md
```

来承载本应属于其他层级的知识。
