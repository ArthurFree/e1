import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import { createBrowserAppServices } from "../platform/web/createBrowserServices";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../platform/web/persistence/db";
import {
  preferencesRepository,
  workspaceRepository,
} from "../platform/web/persistence/repositories";
import { secretStore } from "../platform/web/persistence/secretStore";
import { AI_API_KEY_SECRET } from "../application/services/SecretStore";
import { WebAssetPicker } from "../platform/web/webAssetPicker";
import { SettingsPanel } from "./SettingsPanel";

/** 等 AppProvider 初始加载完成后再渲染面板，避免加载覆盖测试中的保存。 */
function ReadySettingsPanel() {
  const { ready } = useApp();
  return ready ? <SettingsPanel /> : null;
}

/** 临时替换 navigator.storage（jsdom 默认无此属性）。 */
function stubStorageEstimate(estimate: (() => Promise<unknown>) | undefined) {
  const original = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "storage",
  );
  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    get: () => (estimate ? { estimate } : undefined),
  });
  return () => {
    if (original) {
      Object.defineProperty(Navigator.prototype, "storage", original);
    } else {
      delete (Navigator.prototype as unknown as Record<string, unknown>)
        .storage;
    }
  };
}

describe("SettingsPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("未配置时显示未配置状态", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    expect(await screen.findByText("AI 未配置")).toBeInTheDocument();
  });

  it("非法 Endpoint 保存时显示校验错误", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("Endpoint"), {
      target: { value: "not-a-url" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByText("保存"));
    expect(
      await screen.findByText("Endpoint 必须是合法的 http(s) 地址"),
    ).toBeInTheDocument();
    const prefs = await preferencesRepository.get();
    expect(prefs.aiEndpoint).toBeNull();
    expect(prefs.aiModel).toBeNull();
    expect(await secretStore.get(AI_API_KEY_SECRET)).toBeNull();
  });

  it("合法配置保存后 endpoint/model 写入偏好、apiKey 写入 SecretStore，并可清除", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("Endpoint"), {
      target: { value: "https://api.openai.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByText("保存"));

    expect(await screen.findByText("已保存。")).toBeInTheDocument();
    expect(await screen.findByText("AI 已配置")).toBeInTheDocument();
    const prefs = await preferencesRepository.get();
    expect(prefs.aiEndpoint).toBe("https://api.openai.com/v1");
    expect(prefs.aiModel).toBe("gpt-4o-mini");
    // apiKey 不进入偏好记录（R005 阶段 8 §8.2），只在 SecretStore。
    expect("aiConfig" in prefs).toBe(false);
    expect(await secretStore.get(AI_API_KEY_SECRET)).toBe("sk-test");

    fireEvent.click(screen.getByText("清除配置"));
    expect(await screen.findByText("AI 未配置")).toBeInTheDocument();
    const cleared = await preferencesRepository.get();
    expect(cleared.aiEndpoint).toBeNull();
    expect(cleared.aiModel).toBeNull();
    expect(await secretStore.get(AI_API_KEY_SECRET)).toBeNull();
  });
});

describe("SettingsPanel 知识库导出（R005 阶段 7A）", () => {
  let restoreUrl: (() => void) | null = null;
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });
  afterEach(() => {
    restoreUrl?.();
    restoreUrl = null;
    vi.restoreAllMocks();
  });

  /** jsdom 无 URL.createObjectURL：打桩为可断言的固定返回值。 */
  function stubObjectUrl() {
    const created: string[] = [];
    const api = URL as unknown as Record<string, unknown>;
    const originalCreate = api.createObjectURL;
    const originalRevoke = api.revokeObjectURL;
    api.createObjectURL = (blob: Blob) => {
      created.push(blob.type);
      return `blob:mock-${created.length}`;
    };
    api.revokeObjectURL = () => {};
    restoreUrl = () => {
      api.createObjectURL = originalCreate;
      api.revokeObjectURL = originalRevoke;
    };
    return created;
  }

  it("点击导出触发下载并展示摘要", async () => {
    const createdTypes = stubObjectUrl();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );

    const button = await screen.findByRole("button", {
      name: "导出知识库（.e1.zip）",
    });
    fireEvent.click(button);

    // 结果提示：种子知识库含预置文档，篇数 ≥ 1。
    expect(
      await screen.findByText(/已导出 \d+ 篇文档、\d+ 个附件/),
    ).toBeInTheDocument();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/\.e1\.zip$/);
    expect(createdTypes).toEqual(["application/zip"]);
    // 导出完成后按钮恢复可用。
    expect(
      screen.getByRole("button", { name: "导出知识库（.e1.zip）" }),
    ).toBeEnabled();
  });

  it("导出失败时经 notify 通道反馈", async () => {
    stubObjectUrl();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    // 让导出失败：知识库查询抛错（构造服务后立即调用，波及面仅限本测试）。
    const { workspaceRepository } =
      await import("../platform/web/persistence/repositories");
    const listSpy = vi
      .spyOn(workspaceRepository, "list")
      .mockRejectedValueOnce(new Error("磁盘炸了"));

    fireEvent.click(
      await screen.findByRole("button", { name: "导出知识库（.e1.zip）" }),
    );
    await vi.waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringContaining("导出知识库失败"),
      );
    });
    listSpy.mockRestore();
  });
});

describe("SettingsPanel 知识库导入（R005 阶段 7B）", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 手工构造一个最小合法 vault zip（一篇无 Frontmatter 文档）。 */
  async function craftZip(title: string): Promise<Uint8Array> {
    const { createZip } = await import("../application/services/zip");
    const encoder = new TextEncoder();
    return createZip([
      {
        name: "manifest.json",
        data: encoder.encode(
          JSON.stringify({ format: "e1-vault", formatVersion: 1 }),
        ),
      },
      {
        name: "vault.json",
        data: encoder.encode(
          JSON.stringify({
            format: "e1-vault",
            formatVersion: 1,
            name: "导入的库",
          }),
        ),
      },
      {
        name: "notes/a.md",
        data: encoder.encode(`---\ntitle: ${title}\n---\n\n正文\n`),
      },
    ]);
  }

  /** 打桩文件选择器：返回指定 zip 字节（或 null 表示用户取消）。 */
  function stubPicker(data: Uint8Array | null) {
    return vi.spyOn(WebAssetPicker.prototype, "pick").mockResolvedValue(
      data
        ? {
            name: "vault.e1.zip",
            mimeType: "application/zip",
            size: data.byteLength,
            source: { kind: "bytes", data },
          }
        : null,
    );
  }

  it("选择文件 → 导入 → 展示摘要，新知识库落库并出现在列表镜像", async () => {
    const pickSpy = stubPicker(await craftZip("导入文档"));
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "导入知识库（.e1.zip）" }),
    );
    expect(pickSpy).toHaveBeenCalledWith({
      accept: ".zip,application/zip",
    });

    expect(
      await screen.findByText(/已导入到「导入的库」：1 篇文档。/),
    ).toBeInTheDocument();
    // 新知识库已落库（导入不覆盖既有库：种子库仍在）。
    const names = (await workspaceRepository.list()).map((ws) => ws.name);
    expect(names).toContain("导入的库");
    // 导入后按钮恢复可用。
    expect(
      screen.getByRole("button", { name: "导入知识库（.e1.zip）" }),
    ).toBeEnabled();
  });

  it("导入失败（坏 zip）经 notify 通道反馈，不落数据", async () => {
    stubPicker(new TextEncoder().encode("这不是 zip"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const beforeCount = (await workspaceRepository.list()).length;
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "导入知识库（.e1.zip）" }),
    );
    await vi.waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringContaining("导入知识库失败"),
      );
    });
    expect(await workspaceRepository.list()).toHaveLength(beforeCount);
  });

  it("用户取消选择文件时不发起导入、无提示", async () => {
    stubPicker(null);
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "导入知识库（.e1.zip）" }),
    );
    // 等待按钮恢复可用（pick 已 resolve），确认无摘要出现。
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "导入知识库（.e1.zip）" }),
      ).toBeEnabled();
    });
    expect(screen.queryByText(/已导入到/)).toBeNull();
  });
});

describe("SettingsPanel 本地存储区（R004 阶段 6）", () => {
  let restore: (() => void) | null = null;
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("浏览器不支持 Storage API 时显示降级文案", async () => {
    restore = stubStorageEstimate(undefined);
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    expect(
      await screen.findByText("当前浏览器不支持存储用量查询。"),
    ).toBeInTheDocument();
  });

  it("显示已用/配额与占比，低于阈值无警告", async () => {
    restore = stubStorageEstimate(() =>
      Promise.resolve({ usage: 20 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    );
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    expect(
      await screen.findByText(/已使用 20\.0 MB \/ 100\.0 MB（20%）/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("用量达到 80% 阈值时显示空间不足警告", async () => {
    restore = stubStorageEstimate(() =>
      Promise.resolve({ usage: 85 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    );
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("本地存储空间不足");
  });
});

/** 携带 secretStorageStatus 的装配（R007 阶段 5：Desktop 运行时注入）。 */
function renderWithSecretStatus(status: {
  native: boolean;
  persistent: boolean;
}) {
  // createBrowserAppServices 是进程单例——浅拷贝后再覆盖可选字段，
  // 避免污染其他用例共享的容器实例。
  const services = {
    ...createBrowserAppServices(),
    secretStorageStatus: status,
  };
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <ReadySettingsPanel />
      </AppProvider>
    </AppServicesProvider>,
  );
}

describe("SettingsPanel 机密存储提示（R007 阶段 5）", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("persistent=false：提示「本次会话使用」，底部说明不提 IndexedDB/系统安全存储", async () => {
    renderWithSecretStatus({ native: false, persistent: false });
    expect(
      await screen.findByText(
        "系统安全存储不可用，API Key 仅保存在本次会话（重启后需重新填写）。",
      ),
    ).toBeInTheDocument();
    const note = document.querySelector(".settings-panel__note");
    expect(note?.textContent).not.toContain("IndexedDB");
    expect(note?.textContent).not.toContain("系统安全存储");
  });

  it("persistent=true：无降级提示，底部说明为系统安全存储", async () => {
    renderWithSecretStatus({ native: true, persistent: true });
    expect(await screen.findByText(/AI 未配置|AI 已配置/)).toBeInTheDocument();
    expect(screen.queryByText(/系统安全存储不可用/)).toBeNull();
    const note = document.querySelector(".settings-panel__note");
    expect(note?.textContent).toContain("系统安全存储");
  });

  it("未装配 secretStorageStatus（Web）：底部说明保持 IndexedDB 文案", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    await screen.findByText(/AI 未配置|AI 已配置/);
    const note = document.querySelector(".settings-panel__note");
    expect(note?.textContent).toContain("IndexedDB");
    expect(screen.queryByText(/系统安全存储不可用/)).toBeNull();
  });
});
