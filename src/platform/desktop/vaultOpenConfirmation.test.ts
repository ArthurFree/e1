/**
 * R006-C2.1（FR-03）：确认握手模块测试——挂起/决定/取消/单次消费。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  decidePendingVaultSelection,
  discardPendingVaultSelection,
  peekPendingVaultSelection,
  stashPendingVaultSelection,
  takePendingVaultDecision,
} from "./vaultOpenConfirmation";

beforeEach(() => {
  discardPendingVaultSelection();
});

describe("vaultOpenConfirmation 握手", () => {
  it("无挂起：peek 为 null、takeDecision 为 null", () => {
    expect(peekPendingVaultSelection()).toBeNull();
    expect(takePendingVaultDecision()).toBeNull();
  });

  it("挂起后可 peek；decide 后转为决定且挂起清空", () => {
    stashPendingVaultSelection({
      selectionToken: "s-1",
      displayName: "文件夹",
    });
    expect(peekPendingVaultSelection()?.displayName).toBe("文件夹");
    decidePendingVaultSelection(false);
    expect(peekPendingVaultSelection()).toBeNull();
    expect(takePendingVaultDecision()).toEqual({
      selectionToken: "s-1",
      initialize: false,
    });
  });

  it("decide(true) 传递初始化决定；决定单次消费", () => {
    stashPendingVaultSelection({ selectionToken: "s-2", displayName: "库" });
    decidePendingVaultSelection(true);
    expect(takePendingVaultDecision()).toEqual({
      selectionToken: "s-2",
      initialize: true,
    });
    expect(takePendingVaultDecision()).toBeNull();
  });

  it("取消：挂起与决定都清空", () => {
    stashPendingVaultSelection({ selectionToken: "s-3", displayName: "库" });
    discardPendingVaultSelection();
    expect(peekPendingVaultSelection()).toBeNull();
    expect(takePendingVaultDecision()).toBeNull();
  });

  it("无挂起时 decide 为 no-op", () => {
    decidePendingVaultSelection(true);
    expect(takePendingVaultDecision()).toBeNull();
  });

  it("新挂起覆盖旧挂起并清除旧决定", () => {
    stashPendingVaultSelection({ selectionToken: "s-old", displayName: "旧" });
    decidePendingVaultSelection(true);
    stashPendingVaultSelection({ selectionToken: "s-new", displayName: "新" });
    expect(peekPendingVaultSelection()?.selectionToken).toBe("s-new");
    expect(takePendingVaultDecision()).toBeNull();
  });
});
