import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Hero } from "./Hero";

const defaultProps = {
  locale: "en" as const,
  eyebrow: "Open-source AI video editing",
  title: "Edit Final Cut with AI.",
  description: "Tell your AI what you want changed.",
  primaryAction: { href: "/workflow/", label: "Explore" },
  secondaryAction: { href: "/docs/", label: "Docs" },
};

describe("Hero", () => {
  it("leads with creator value and shows the review-first workflow", () => {
    render(<Hero {...defaultProps} />);

    expect(screen.getByRole("heading", { level: 1, name: "Edit Final Cut with AI." })).toBeInTheDocument();
    expect(screen.getByText("FrameKit")).toBeInTheDocument();
    expect(screen.getByText("PREVIEW READY")).toBeInTheDocument();
    expect(screen.getByText("0 mutations")).toBeInTheDocument();
  });

  it("localizes the editing prompt", () => {
    render(<Hero {...defaultProps} locale="ja" />);

    expect(screen.getByText(/無音部分をカット/)).toBeInTheDocument();
  });
});
