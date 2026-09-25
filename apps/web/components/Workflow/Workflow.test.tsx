import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Workflow } from "./Workflow";

describe("Workflow", () => {
  it("renders each review-first workflow step in order", () => {
    render(
      <Workflow
        eyebrow="How it works"
        title="A deliberate workflow"
        description="Review before execution."
        steps={[
          { label: "Understand", title: "Read", description: "Read context." },
          { label: "Review", title: "Preview", description: "Check the target." },
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("01");
    expect(items[1]).toHaveTextContent("02");
  });
});
