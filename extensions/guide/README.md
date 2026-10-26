# 编写与注册扩展

当前支持单个 JSON 文件，参见 [阅读摘录样例](../sample-independent-domain/extension.json)。在工作空间管理中选择文件或粘贴 JSON，先查看名称、稳定身份、版本、兼容性和访问范围，再明确注册。新领域默认停用，可另行启用。

格式 1 使用 hostApi 1、dataVersion 1、own-domain 访问范围。稳定身份使用小写字母、数字、点或连字符；system 与 builtin 前缀保留。不要用相同身份发布不同包冒充重复注册；当前不提供程序升级或数据格式迁移。

schema 使用 JSON Schema 2020-12 的受限对象子集：type 为 object，additionalProperties 为 false，properties 支持 string、number、boolean，可选 enum 和文本 maxLength；required 明确必填字段。当前不支持嵌套对象、远端引用、脚本或未知关键字。完整规则由 packages/extension-sdk/src/validation/validate.ts 维护。

view 的 titleField 和 fields 引用声明字段。actions 声明 create、update、delete；界面由宿主安全渲染，扩展包不能注入 HTML、调用 SQL、文件系统或网络，也不能获取其他领域数据。当前目录可进入声明式表单和内容列表；删除需明确确认具体内容。

空间登记和启用状态进入本机待同步成果，联网同步及导出由后续节点接入。程序材料仅安装在当前设备，不因取得登记而自动安装到另一设备。程序移除保留空间登记、启用状态及内容；使用完全相同的原包可补齐并接续数据。

离开、停用、移除或关闭窗口前，有未保存输入时选择保存后继续、明确放弃或取消。正在保存或结果尚未确认时，不能把尚未核对的提交直接丢弃。应用崩溃后的未提交草稿恢复不属于当前已确认能力。
