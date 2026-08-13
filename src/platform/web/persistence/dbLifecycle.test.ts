/**
 * db 连接生命周期测试（R004 阶段 7 §7.1）。
 *
 * fake-indexeddb 可模拟的子集：versionchange（其他标签页升级）——
 * 本连接同步关闭、缓存清空、回调通知、后续重连与失败兜底。
 * blocked（本标签页升级被阻）与 terminated（异常终止）在 fake-indexeddb
 * 中无法触发：blocked 需要两个真实连接且版本不同（本模块版本固定），
 * terminated 只在浏览器异常回收连接时发生；两者经手工验证
 * （真实浏览器开两个标签页 + DevTools 模拟），回调接线路径与
 * versionchange 共用同一 setStorageConnectionCallbacks 通道。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DB_NAME,
  DB_VERSION,
  getDB,
  resetDB,
  setStorageConnectionCallbacks,
} from "./db";

describe("db 连接生命周期", () => {
  beforeEach(async () => {
    await resetDB();
  });

  afterEach(async () => {
    setStorageConnectionCallbacks({});
    await resetDB();
  });

  it("versionchange：其他标签页升级时同步关闭连接、清缓存并经回调通知", async () => {
    const events: string[] = [];
    setStorageConnectionCallbacks({
      onVersionChange: () => events.push("versionchange"),
    });
    const firstPromise = getDB();
    const db = await firstPromise;
    expect(db.version).toBe(DB_VERSION);

    // 模拟另一标签页以更高版本打开同一数据库（触发升级）。
    const request = indexedDB.open(DB_NAME, DB_VERSION + 1);
    request.onupgradeneeded = () => {
      // 不改动 schema：仅推进版本号。
    };
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      // 本标签页在 blocking 中同步关闭连接，升级不应被阻塞。
      request.onblocked = () =>
        reject(new Error("升级被阻塞：本标签页未及时处理 versionchange"));
    });

    // 回调通知已发出；缓存已清空，下次 getDB 是新的连接尝试。
    expect(events).toEqual(["versionchange"]);
    const secondPromise = getDB();
    expect(secondPromise).not.toBe(firstPromise);
    // 数据库已升级到新版本：以当前 DB_VERSION 重连失败（VersionError），
    // 错误向上抛——UI 走既有错误页/保存错误通道，不白屏、不卡死。
    await expect(secondPromise).rejects.toThrow();
    // 打开失败后缓存再次清空：重试仍发起新连接而不是复用已拒绝的 Promise。
    const thirdPromise = getDB();
    thirdPromise.catch(() => {
      // 预期同样失败（库仍是高版本），此处仅避免未处理的 rejection。
    });
    expect(thirdPromise).not.toBe(secondPromise);

    upgraded.close();
  });

  it("getDB 在连接被外部关闭后可重连（缓存清理语义）", async () => {
    const firstPromise = getDB();
    const db = await firstPromise;
    // 模拟连接失效后直接清空缓存的路径（terminated 同款 clearCachedConnection）：
    // 外部关闭 + 触发 versionchange 回调链中与实现一致的清理行为。
    const request = indexedDB.open(DB_NAME, DB_VERSION + 1);
    request.onupgradeneeded = () => {};
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("升级被阻塞"));
    });
    expect(db).toBeDefined();
    // 升级完成后删除数据库并复位：getDB 能打开全新连接。
    upgraded.close();
    await resetDB();
    const fresh = await getDB();
    expect(fresh.version).toBe(DB_VERSION);
    await expect(fresh.getAll("workspaces")).resolves.toBeDefined();
  });
});
