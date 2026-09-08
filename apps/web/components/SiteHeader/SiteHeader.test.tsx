import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteHeader } from "./SiteHeader";

describe("SiteHeader", () => {
  it("links English visitors into the product funnel", () => {
    render(<SiteHeader locale="en" />);

    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Use Cases" })).toHaveAttribute(
      "href",
      "/use-cases/final-cut-pro-ai",
    );
    expect(screen.getByRole("link", { name: "日本語" })).toHaveAttribute("href", "/ja");
  });

  it("shows the technical context in the docs variant", () => {
    render(<SiteHeader locale="ja" variant="docs" />);

    expect(screen.getByText("/ Docs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "始める" })).toHaveAttribute("href", "/ja/docs");
  });
});
