# 知识图谱（R015 / R015.1）

Graph 是 LinkIndex 的可丢弃投影（GRAPH-01/09），不是新的用户事实存储。Markdown 仍是真相。

**状态：Local Graph + 有界 Workspace Graph 产品化（R015.1）已接线**——Batch Graph IPC、真实 tags/groupPath、Canvas、Invalidation、G72–G83 / P31–P34 已落地。R015 在远端 Golden 全绿、真实 packaged P31–P34 与 10k 性能达标之前**不得**标成已完成。需求见 `docs/requirements/R014.1-R015-review-R015.1-R016-plan.md`。

## 不变量

- nodeId = stable page id，禁止按 title 解析。
- broken 是边状态（`targetId: null`），不虚构文档节点。
- 查询必须 bounded（depth / nodeLimit≤200 / edgeLimit≤500）。
- Graph 失败不得阻断保存。
- UI 只依赖 `AppServices.graph`（`GraphQueryPort`），不碰 SQL / fs。
- UI 不得直接订阅文件系统 watcher；只订阅 `AppServices.graphInvalidation`。
- Web 不装配 `graph`（与 `linkIndex` 同口径存在性门控）。

## 链路

```text
Markdown → LinkIndex（SQLite）
  → graph:* IPC（Main 一次取出 docs/links）
  → shared/graph/project.ts 有界投影
  → DesktopGraphQuery（ScanCache 合并 title/path/tags/groupPath）
  → LocalGraphPanel / WorkspaceGraphPanel → GraphCanvas
```

内存/测试路径仍走 `GraphProjectionService`（先 snapshot LinkIndex，再调用同一套 `project.ts`）。

## Batch Query

Renderer 不再对每个节点 `getOutgoing` / `getBacklinks`。Main `DesktopLinkDatabase.listGraphDocs` + `listGraphInternalLinks` 各一次 SQL，随后纯函数投影。

Tag 过滤：LinkIndex 无 tags 列。`DesktopGraphQuery` 用扫描缓存把命中的 stable id 填入 `filters.noteKeys`，Main 按 id 集合截取。

## Invalidation

```text
Save / Watcher / Rename / Move / Trash / Restore / Broken Repair / Revision Restore
  → LinkIndex Reconcile
  → GraphInvalidationChannel.publish()
  → Local / Workspace Graph 重新查询
```

## Local Graph

当前文档空间关系图：中心 / 入边（左）/ 出边（右）/ depth=2 第二跳。点击节点打开文档；失效边可经 PagePicker 修复。

## Workspace Graph

有界 Canvas（≤200 节点 / ≤500 边）：平移、缩放、适应窗口、搜索居中、键盘选择。筛选：搜索 / Group / Tag / 孤立文档 / 失效边。截断时提示缩小范围。

## 性能

产品目标（10k notes，`npm run test:perf`）：depth=1 p95 < 50ms、depth=2 p95 < 150ms、有界 Workspace p95 < 300ms。不得把整库 10k 图送进 Renderer。
