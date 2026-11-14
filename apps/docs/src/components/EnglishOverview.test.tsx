import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { EnglishOverview } from "./EnglishOverview";

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

it("introduces the product with one hero and no article breadcrumb", () => {
  render(<EnglishOverview />);
  expect(
    screen.getByText(/Bring your video workflow into Codex/),
  ).toHaveTextContent("Bring your video workflow into Codex. Inspect projects");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Video editing, in your own words.",
  );
  expect(
    screen.queryByRole("navigation", { name: "Breadcrumb" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^Get started/ })).toHaveAttribute(
    "href",
    "/en/docs/installation",
  );
  expect(screen.getByRole("link", { name: /^View on GitHub/ })).toHaveAttribute(
    "href",
    "https://github.com/morshoto/framekit",
  );
});

it("labels the conceptual illustration and separates product and contributor paths", () => {
  render(<EnglishOverview />);
  expect(screen.getByText(/not an application screenshot/)).toBeInTheDocument();
  expect(screen.getByText(/Do not edit anything/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Work with a Framekit project/ }),
  ).toHaveAttribute("href", "/en/docs/headless-editing");
  expect(
    screen.getByRole("link", { name: /Set up the integration/ }),
  ).toHaveAttribute("href", "/en/docs/final-cut-pro");
  expect(
    screen.getByRole("link", { name: /Contributor guide/ }),
  ).toHaveAttribute("href", "/en/docs/development");
  expect(
    screen.getByRole("heading", { name: "Support Framekit" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Our contributors" }),
  ).toBeInTheDocument();
});

it("retains search, theme, and language controls on the landing page", async () => {
  render(<EnglishOverview />);
  const header = within(screen.getByRole("banner"));
  expect(header.getByRole("link", { name: "日本語" })).toBeInTheDocument();
  expect(
    header.getByRole("button", { name: /Switch to .* theme/ }),
  ).toBeInTheDocument();
  await userEvent.click(header.getByRole("button", { name: /^Search docs/ }));
  expect(
    screen.getByRole("dialog", { name: "Search documentation" }),
  ).toBeInTheDocument();
});
