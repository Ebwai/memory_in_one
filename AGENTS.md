<!-- Agent Asset Manager: start -->
# 项目配置

## 已应用的 Skills 套件

### 软件的全流程开发技能包
用途：软件开发从MRD->PRD->Architecture->TDD的完整流程以及其过程中的文档记录和更新；
结合文档和代码设计实现的全库代码导航指引

- `docs-generator`：MRD->PRD->Architecture->TDD文档书写要求
- `codebase-index`：代码仓库的导航
- `development-workflow`：调度文档和文档检索的调度skills
<!-- Agent Asset Manager: end -->

- 编译产物的放置位置：
	- 客户端：
		- Windows版：`\.build\release\user_application\windows\\{user_windows_v{x}.{x}.{x}}`
		- Android版：`\.build\release\user_application\android\{user_android_v{x}.{x}.{x}}`
	- server端程序
		- Ubuntu版：`\.build\release\server_application\ubuntu\{server_ubuntu_v{x}.{x}.{x}}`
- 所有测试性质的文件或者脚本全部放在`.\tests`目录下，且每个版本的测试对应一个文件夹