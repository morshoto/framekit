import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "./SiteFooter";

describe("SiteFooter", () => {
  it("keeps discovery and evidence destinations reachable", () => {
    render(<SiteFooter locale="en" />);

    expect(screen.getByRole("link", { name: "Learn" })).toHaveAttribute("href", "/learn/final-cut-pro-ai");
    expect(screen.getByRole("link", { name: "Compatibility" })).toHaveAttribute(
      "href",
      "https://github.com/morshoto/framekit/blob/main/docs/COMPATIBILITY.md",
    );
  });

  it("uses Japanese route prefixes", () => {
    render(<SiteFooter locale="ja" />);

    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/ja/docs");
  });
});
