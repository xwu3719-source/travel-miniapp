# 拾途 ST 产品收口增强 QA

- source visual truth path: existing app blue glass style in index / ledger / notification-center / settlement pages
- implementation preview path: `/Users/xiyue/Desktop/travel-miniapp/outputs/dashboard-inbox-settlement-2026-06-27.png`
- viewport: iPhone / 微信小程序
- state: 首页当前行程仪表盘、通知中心聚合、结算凭证、账本相关页面
- full-view comparison evidence: 微信开发者工具 preview 编译通过，未捕获真机交互截图
- focused region comparison evidence: 代码结构和组件状态检查；真机视觉待确认

## Findings

- 无代码或编译层面的 P0、P1、P2 问题。
- P3: 首页仪表盘、通知聚合、结算凭证尚未在真机截图中确认实际视觉细节和滚动手感。

## Required fidelity surfaces

- Fonts and typography: 统一首页、通知中心、账本和结算页面的标题、说明文字、金额字号和卡片层级。
- Spacing and layout rhythm: 首页先当前行程仪表盘和快捷入口，再展示行程列表；通知中心先聚合收件箱，再展示互动列表；结算页支持凭证/清单。
- Colors and visual tokens: 使用 `var(--gradient-trip)`、`var(--trip-blue-light)`、`var(--trip-blue-deep)`。
- Image quality and asset fidelity: 使用现有真实 icon，不新增 emoji 或占位图。
- Copy and content: 使用“当前行程 / 今日安排 / 待处理 / 转账清单 / 结算凭证”等产品收口语义。
- Interaction states: 列表点击进入详情；凭证图标阻止冒泡；已结算账单禁止编辑、删除、退款。

## Patches made since previous QA

- 账本首页新增旅行账本总览卡，移除重复统计块，将账单明细提前，账本分析后置。
- 账本首页筛选、账单卡片、快捷操作统一浅蓝玻璃风格。
- 记一笔/编辑账单改为金额优先布局，公共/私人选择并入金额主卡，常用模板下移。
- 结算页新增本次结算总览卡，成员汇总改为 2 列信息块，转账/待结算明细统一轻卡片。
- 账单详情顶部金额卡和信息卡统一为浅蓝玻璃视觉。
- 清理账本相关页面残留的紫粉、橙金旧视觉关键词和阴影。
- 首页新增当前行程仪表盘，展示今日安排、预算、未读待办、最新动态和快捷入口。
- 通知中心新增消息、好友申请、互动通知聚合卡片。
- 结算页新增转账清单复制、结算凭证复制、历史凭证复制。
- 首页、通知、结算相关页面清理橙金旧视觉关键词。

## Implementation checklist

- [x] 账本首页信息顺序重排
- [x] 记一笔页面金额优先布局
- [x] 结算页新增总览和卡片层级
- [x] 账单详情视觉统一
- [x] 移除账本相关页面旧橙/紫关键词
- [x] 冒烟检查通过：56 个 JS 文件、39 个页面
- [x] 微信开发者工具预览编译，主包 1.6 MB
- [x] 首页当前行程仪表盘
- [x] 通知中心聚合卡片
- [x] 结算清单/凭证复制
- [x] 冒烟检查通过：57 个 JS 文件、40 个页面
- [x] 微信开发者工具预览编译，主包 1.6 MB
- [ ] 真机截图确认首页、通知中心、结算页视觉

final result: blocked
