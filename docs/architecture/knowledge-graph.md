# 知识图谱（R015）

Graph 是 LinkIndex 的可丢弃投影（GRAPH-01/09），不是新的用户事实存储。Markdown 仍是真相。

**状态：Local Graph + 有界 Workspace Graph 已落地。** 10k Vault 的 SQL 邻域查询与 Desktop Golden G72+ / packaged P31–P34 尚未作为关闭条件。需求见 `docs/requirements/R014.1-closeout-and-R015-knowledge-graph-plan.md`。

## 不变量

- nodeId = stable page id，禁止按 title 解析。
- broken 是边状态（`targetId: null`），不虚构文档节点。
- 查询必须 bounded（depth / nodeLimit≤200 / edgeLimit≤500）。
- Graph 失败不得阻断保存。
- UI 只依赖 `AppServices.graph`（`GraphQueryPort`），不碰 SQL / fs。
- Web 不装配 `graph`（与 `linkIndex` 同口径存在性门控）。

## 链路

```text
Markdown → LinkIndex
  → GraphProjectionService（application）
  → DesktopGraphQuery（扫描目录提供 title/path）
  → LocalGraphPanel / WorkspaceGraphPanel
```

Local Graph：当前文档 `getOutgoing` + `getBacklinks`，depth 1|2，O(邻域)。

Workspace Graph：有界列出文档节点并取 internal 边；支持搜索、孤立文档、失效边开关。Orphan v1 = resolved in=0 且 resolved out=0。
