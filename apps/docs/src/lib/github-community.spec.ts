import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadContributors, loadFunding } from "./github-community";

const response = (data: unknown) => ({ ok: true, json: async () => data });
const human = {
  login: "morshoto",
  type: "User",
  html_url: "https://github.com/morshoto",
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
};
const bot = {
  login: "renovate[bot]",
  type: "Bot",
  html_url: "https://github.com/apps/renovate",
  avatar_url: "https://avatars.githubusercontent.com/in/2740?v=4",
};
const funding = (text: string) =>
  response({ encoding: "base64", content: btoa(text) });
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("includes people and automated contributors with validated GitHub URLs", async () => {
  vi.mocked(fetch).mockResolvedValue(response([human, bot]) as Response);
  expect(await loadContributors()).toEqual([
    {
      login: "morshoto",
      profile: human.html_url,
      avatar: human.avatar_url,
      bot: false,
    },
    {
      login: "renovate[bot]",
      profile: bot.html_url,
      avatar: bot.avatar_url,
      bot: true,
    },
  ]);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/morshoto/framekit/contributors?per_page=100",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it("rejects malformed profiles, external hosts, credentials and unsupported types", async () => {
  vi.mocked(fetch).mockResolvedValue(
    response([
      human,
      { ...human, html_url: "https://github.com.evil.test/me" },
      { ...human, avatar_url: "javascript:alert(1)" },
      { ...human, html_url: "https://evil@github.com/me" },
      { ...human, type: "Unknown" },
      null,
    ]) as Response,
  );
  expect(await loadContributors()).toHaveLength(1);
});
it("returns an empty public contributor list without inventing people", async () => {
  vi.mocked(fetch).mockResolvedValue(response([]) as Response);
  expect(await loadContributors()).toEqual([]);
});
it.each([
  "github: morshoto",
  'github: [morshoto, "someone"]',
  "github:\n  - morshoto\n  - someone\ncustom: https://example.test",
])("reads GitHub funding accounts: %s", async (text) => {
  vi.mocked(fetch).mockResolvedValue(funding(text) as Response);
  expect(await loadFunding()).toEqual(
    text.includes("someone") ? ["morshoto", "someone"] : ["morshoto"],
  );
});
it.each(["github: null", "github: []", "custom: https://example.test"])(
  "does not invent funding recipients: %s",
  async (text) => {
    vi.mocked(fetch).mockResolvedValue(funding(text) as Response);
    expect(await loadFunding()).toEqual([]);
  },
);
it("rejects invalid funding accounts and malformed API responses", async () => {
  vi.mocked(fetch).mockResolvedValue(
    funding('github: [morshoto, "https://evil.test", bad/login]') as Response,
  );
  expect(await loadFunding()).toEqual(["morshoto"]);
  vi.mocked(fetch).mockResolvedValue(
    response({ message: "invalid" }) as Response,
  );
  await expect(loadContributors()).rejects.toThrow();
});
it("caches public results for one hour and refreshes expired data", async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockResolvedValue(response([human]) as Response);
  await loadContributors();
  await loadContributors();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3600001);
  await loadContributors();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not cache rate limits and can recover on the next request", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
    .mockResolvedValue(response([human]) as Response);
  await expect(loadContributors()).rejects.toThrow();
  expect(await loadContributors()).toHaveLength(1);
});
it("bounds a stalled request and aborts its network operation", async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  const result = expect(loadContributors()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(8000);
  await result;
  const options = vi.mocked(fetch).mock.calls[0][1];
  expect(options?.signal?.aborted).toBe(true);
});
it("cancels a pending request when its consumer leaves", async () => {
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = expect(loadContributors(controller.signal)).rejects.toThrow();
  controller.abort();
  await result;
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("remains usable when browser storage is disabled", async () => {
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  vi.mocked(fetch).mockResolvedValue(response([human]) as Response);
  expect(await loadContributors()).toHaveLength(1);
  get.mockRestore();
  set.mockRestore();
});
