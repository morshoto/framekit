export interface FinalCutBrowserSearchAccessibilityNode {
  role: "AXButton" | "AXGroup" | "AXOutline" | "AXScrollArea" | "AXToolbar";
  label?: string;
  children?: FinalCutBrowserSearchAccessibilityNode[];
}

export const finalCutBrowserSearchAccessibilityFixture = {
  unrelatedToggle: {
    role: "AXGroup" as const,
    label: "Effects",
    children: [
      {
        role: "AXToolbar" as const,
        children: [{ role: "AXButton" as const, label: "Toggle Search Bar" }],
      },
    ],
  } satisfies FinalCutBrowserSearchAccessibilityNode,
  browser: {
    role: "AXGroup" as const,
    label: "Browser",
    children: [
      {
        role: "AXToolbar" as const,
        children: [{ role: "AXButton" as const, label: "Toggle Search Bar" }],
      },
      {
        role: "AXScrollArea" as const,
        label: "Organizer",
        children: [{ role: "AXOutline" as const, label: "Browser media list" }],
      },
    ],
  } satisfies FinalCutBrowserSearchAccessibilityNode,
};
