import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CapabilityGrid } from "./CapabilityGrid";

describe("CapabilityGrid", () => {
  it("renders explicit status and evidence for every capability", () => {
    render(
      <CapabilityGrid
        locale="en"
        eyebrow="Status"
        title="Capabilities"
        description="Evidence-backed claims."
        capabilities={[
          {
            id: "live-context",
            status: "available",
            source: "docs/COMPATIBILITY.md",
            title: "Live context",
            description: "Metadata only.",
          },
          {
            id: "write",
            status: "coming-soon",
            source: "docs/COMPATIBILITY.md",
            title: "Canonical writes",
            description: "Not bundled today.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Available now")).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /View evidence/ })[0]).toHaveAttribute(
      "href",
      "https://github.com/morshoto/framekit/blob/main/docs/COMPATIBILITY.md",
    );
  });
});
