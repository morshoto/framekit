import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WikiArticle } from "./WikiArticle";

describe("WikiArticle", () => {
  it("renders Markdown content, topics, and the next funnel step", () => {
    render(
      <WikiArticle
        locale="en"
        eyebrow="Learn"
        title="AI editing"
        description="An introduction."
        body={"## Review first\n\nKeep **capabilities** visible."}
        keywords={["Final Cut Pro AI"]}
        nextHref="/docs/"
        nextLabel="Read the docs"
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Review first" })).toBeInTheDocument();
    expect(screen.getByText("capabilities")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Topics" })).toHaveTextContent("Final Cut Pro AI");
    expect(screen.getByRole("link", { name: /Read the docs/ })).toHaveAttribute("href", "/docs");
  });
});
