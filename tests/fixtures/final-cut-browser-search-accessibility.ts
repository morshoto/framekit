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
  currentLayout: {
    role: "AXGroup" as const,
    label: "group",
    children: [
      { role: "AXButton" as const, label: "Toggle Search Bar" },
      {
        role: "AXSplitGroup" as const,
        children: [
          {
            role: "AXScrollArea" as const,
            label: "scroll area",
            children: [{ role: "AXOutline" as const, label: "Event media sidebar" }],
          },
          { role: "AXScrollArea" as const, label: "Organizer filmlist scroll view" },
        ],
      },
    ],
  } satisfies FinalCutBrowserSearchAccessibilityNode,
};
