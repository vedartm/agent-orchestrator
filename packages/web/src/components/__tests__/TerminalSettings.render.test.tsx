import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalSettingsPanel, THEME_PRESETS, type TerminalSettings } from "../TerminalSettings";

const DEFAULT_SETTINGS: TerminalSettings = {
  fontSize: 14,
  cursorStyle: "bar",
  themeName: "github-dark",
};

describe("TerminalSettingsPanel", () => {
  it("renders font size buttons", () => {
    const onUpdate = vi.fn();
    render(
      <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={onUpdate} onClose={vi.fn()} />,
    );

    expect(screen.getByText("Font Size")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("13")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("16")).toBeInTheDocument();
  });

  it("calls onUpdate with new font size when clicked", () => {
    const onUpdate = vi.fn();
    render(
      <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={onUpdate} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("16"));
    expect(onUpdate).toHaveBeenCalledWith({ fontSize: 16 });
  });

  it("renders cursor style buttons", () => {
    const onUpdate = vi.fn();
    render(
      <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={onUpdate} onClose={vi.fn()} />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Block")).toBeInTheDocument();
    expect(screen.getByText("Bar")).toBeInTheDocument();
    expect(screen.getByText("Underline")).toBeInTheDocument();
  });

  it("calls onUpdate with new cursor style when clicked", () => {
    const onUpdate = vi.fn();
    render(
      <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={onUpdate} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("Block"));
    expect(onUpdate).toHaveBeenCalledWith({ cursorStyle: "block" });
  });

  it("renders all theme preset labels", () => {
    const onUpdate = vi.fn();
    render(
      <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={onUpdate} onClose={vi.fn()} />,
    );

    expect(screen.getByText("Theme")).toBeInTheDocument();
    for (const preset of THEME_PRESETS) {
      expect(screen.getByText(preset.label)).toBeInTheDocument();
    }
  });

  it("calls onUpdate with new theme name when a swatch is clicked", () => {
    const onUpdate = vi.fn();
    render(
      <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={onUpdate} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("Dracula"));
    expect(onUpdate).toHaveBeenCalledWith({ themeName: "dracula" });
  });

  it("calls onClose when clicking outside the panel", () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">outside</div>
        <TerminalSettingsPanel settings={DEFAULT_SETTINGS} onUpdate={vi.fn()} onClose={onClose} />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalled();
  });
});
