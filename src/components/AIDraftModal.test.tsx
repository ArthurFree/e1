import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useApp } from "../state/AppState";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../platform/web/persistence/db";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  workspaceRepository,
} from "../platform/web/persistence/repositories";
import { secretStore } from "../platform/web/persistence/secretStore";
import { AI_API_KEY_SECRET } from "../application/services/SecretStore";
import { AIDraftModal } from "./AIDraftModal";

const AI_CONFIG = {
  endpoint: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

/** R005 阶段 8 §8.2：endpoint/model 入偏好，apiKey 入 SecretStore。 */
async function configureAI() {
  await preferencesRepository.update({
    aiEndpoint: AI_CONFIG.endpoint,
    aiModel: AI_CONFIG.model,
  });
  await secretStore.set(AI_API_KEY_SECRET, AI_CONFIG.apiKey);
}

function mockFetchDraft(markdown: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: markdown } }] }),
    })),
  );
}

function Harness() {
  const { ready, view } = useApp();
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      {ready && <AIDraftModal onClose={() => undefined} />}
    </>
  );
}

async function docTitles() {
  const [ws] = await workspaceRepository.list();
  const pages = await pageRepository.listByWorkspace(ws.id);
  return pages.filter((p) => p.kind === "document").map((p) => p.title);
}

describe("AIDraftModal", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    await configureAI();
    mockFetchDraft("# Q3 复盘\n\n本季度完成了三项里程碑。");
  });

  it("生成预览后确认才创建文档，正文经白名单解析", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "Q3 复盘" },
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /我的知识库/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    // 预览出现，但尚未创建文档。
    const preview = await screen.findByLabelText("AI 生成预览");
    expect(preview).toHaveValue("# Q3 复盘\n\n本季度完成了三项里程碑。");
    expect(await docTitles()).not.toContain("Q3 复盘");

    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
    const [ws] = await workspaceRepository.list();
    const pages = await pageRepository.listByWorkspace(ws.id);
    const created = pages.find((p) => p.title === "Q3 复盘");
    expect(created).toBeDefined();
    const content = await contentRepository.get(created!.id);
    expect(content?.textSnapshot).toContain("本季度完成了三项里程碑");
    // Markdown 标题经解析为结构化内容，不是原文。
    expect(JSON.stringify(content?.contentJson)).toContain("heading");
  });

  it("取消流程不创建文档", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "不要创建" },
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /我的知识库/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    await screen.findByLabelText("AI 生成预览");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await docTitles()).not.toContain("不要创建");
  });

  it("生成失败时显示错误且不创建文档", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "失败案例" },
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /我的知识库/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/不可用|失败/);
    expect(await docTitles()).not.toContain("失败案例");
  });

  // R009 收口 §8：代次令牌守卫——组件卸载后迟到的 provider 响应被静默
  // 丢弃，不再 setState（否则 React Scheduler 在 jsdom 销毁后继续调度，
  // 抛 unhandled "window is not defined"，与 AIAssistantPanel 同型）。
  it("生成中卸载后迟到的响应被丢弃（不 setState、无 unhandled error）", async () => {
    const deferred: { resolve: (value: unknown) => void } = {
      resolve: () => {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            deferred.resolve = resolve;
          }),
      ),
    );
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "迟到响应" },
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /我的知识库/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    await screen.findByText("正在生成草稿…");

    // 关闭弹窗（卸载组件）：作废进行中的请求令牌。
    cleanup();
    // provider 迟到返回：令牌已失效，结果被丢弃，不触发任何 setState。
    deferred.resolve({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "# 迟到的草稿" } }],
      }),
    });
    // 排空宏任务，让迟到的 promise 回调完整落地（进程级 unhandled
    // error 会被测试底座捕获并使本用例失败）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await docTitles()).not.toContain("迟到响应");
  });
});
