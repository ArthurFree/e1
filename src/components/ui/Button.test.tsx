import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

describe("Button", () => {
  beforeEach(() => cleanup());
  it("默认次要变体，支持主要/危险变体", () => {
    render(
      <>
        <Button>保存</Button>
        <Button variant="primary">创建</Button>
        <Button variant="danger">删除</Button>
      </>,
    );
    expect(screen.getByText("保存").className).toContain("button--secondary");
    expect(screen.getByText("创建").className).toContain("button--primary");
    expect(screen.getByText("删除").className).toContain("button--danger");
  });

  it("禁用态不可点击", () => {
    render(<Button disabled>保存</Button>);
    expect(screen.getByText("保存")).toBeDisabled();
  });
});

describe("IconButton", () => {
  beforeEach(() => cleanup());
  it("label 同时用于无障碍名称与 Tooltip", () => {
    render(<IconButton label="收藏">☆</IconButton>);
    const button = screen.getByRole("button", { name: "收藏" });
    expect(button).toHaveAttribute("title", "收藏");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("激活态同步 aria-pressed 与样式", () => {
    render(
      <IconButton label="收藏" active>
        ★
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "收藏" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className).toContain("icon-button--active");
  });
});
