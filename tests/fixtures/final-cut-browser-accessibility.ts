export interface FinalCutBrowserAccessibilityMediaFixture {
  role: "AXGroup" | "AXStaticText" | "AXImage";
  value: string;
  description: string;
  selected: boolean;
  axIdentifier: string;
  bounds: string;
}

export const finalCutBrowserAccessibilityFixture = {
  container: {
    role: "AXGroup" as const,
    description: "Events",
  },
  media: [
    {
      role: "AXGroup" as const,
      value: "Blue Steel Guitar",
      description: "media item",
      selected: true,
      axIdentifier: "fcp://media/blue-steel-guitar",
      bounds: "(561, 210)|(120, 80)",
    },
    {
      role: "AXStaticText" as const,
      value: "Blue Steel Guitar",
      description: "media item title",
      selected: false,
      axIdentifier: "fcp://media/blue-steel-guitar",
      bounds: "(561, 210)|(120, 20)",
    },
    {
      role: "AXImage" as const,
      value: "Unidentified imported audio",
      description: "media item",
      selected: false,
      axIdentifier: "",
      bounds: "(701, 210)|(120, 80)",
    },
    {
      role: "AXStaticText" as const,
      value: "Blue Steel Guitar",
      description: "duplicate media item title",
      selected: false,
      axIdentifier: "fcp://media/blue-steel-guitar-copy",
      bounds: "(841, 210)|(120, 20)",
    },
  ] satisfies FinalCutBrowserAccessibilityMediaFixture[],
};
