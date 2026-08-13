# IndexedDB v5 迁移说明

## 变更清单（v4 → v5）

纯增量升级（R005 阶段 8B）：新增机密存储，并把 AI `apiKey` 从普通偏好模型剥离。

| 目标            | 变更                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 新 store        | `secrets`（`keyPath: "name"`）：SecretStore 的 Web 实现，记录形状 `{ name, value }`                                                       |
| preferences     | 旧字段 `aiConfig: { endpoint, model, apiKey }` → `aiEndpoint` / `aiModel`；删除 `aiConfig`；非空 `apiKey` 写入 `secrets` 名为 `"ai.apiKey"` |

无 pages/contents 等业务 store 的字段或索引变更（相对 v4）。

## 迁移过程

全部在 versionchange 事务内完成（`upgradeToV5`，见 `src/platform/web/persistence/db.ts`）：

1. 创建 `secrets` object store（`keyPath: "name"`）；
2. 读取单例偏好记录 `preferences`；
3. 若存在旧版 `aiConfig` 对象：
   - `apiKey` 为非空字符串时，写入 `{ name: "ai.apiKey", value: apiKey }`；
   - 若记录尚无 `aiEndpoint` / `aiModel`，从 `aiConfig.endpoint` / `aiConfig.model` 写入（已由新代码写过的字段不覆盖）；
4. 删除 `aiConfig` 字段并 `put` 回 preferences。

无旧配置（`aiConfig` 为 `null` / 缺失 / 非对象）时：仍创建 `secrets` store，不产生 secret，偏好记录正常剥离（若无可删字段则为 no-op）。幂等语义由「upgrade 对每个库只执行一次」保证。

迁移失败由升级事务天然整体回滚。

## 读写路径（迁移后）

- 偏好仓储只读写非机密设置（theme / sidebarWidth / aiEndpoint / aiModel / lastRoute 等）。
- AI 密钥经 `SecretStore.get/set("ai.apiKey")`；`AIConfigService` 组装完整 `AIConfig`（endpoint/model 取偏好 + apiKey 取 SecretStore），secret 变更不跨标签页广播。
- 读路径对仍含 `aiConfig` 的异常存量做兜底剥离（见 `repositories.ts` 偏好规范化），正常库在 upgrade 后不应再出现该字段。

## 测试

`src/platform/web/persistence/dbV5Migration.test.ts`：

- 空库直接建 v5：`secrets` store 就位；
- v4 fixture 含 `aiConfig.apiKey` → secret 可读、偏好为 `aiEndpoint`/`aiModel` 且无 `aiConfig`；
- v4 fixture `aiConfig: null` → 无 secret、偏好 endpoint/model 为 null；
- v1 老库跳级 v5：secrets store 与 apiKey 迁移叠加生效。

## 回滚

不支持降级 `DB_VERSION` 回退（浏览器拒绝低版本打开）。v5 新增 store 与偏好字段改写：旧版代码（v4）打开 v5 库时多余 `secrets` store 被忽略，但偏好已无 `aiConfig.apiKey`，旧代码无法再读出密钥——回退到 v4 代码运行不应超过一个配置保存周期。
