import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App.jsx";
import VideoDownloaderPage from "../src/pages/VideoDownloaderPage.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" }
});

const verificationRequired = () => json({
  error: "The site requires browser verification.",
  code: "VIDEO_VERIFICATION_REQUIRED",
  canVerifyInBrowser: true
}, 403);

async function renderVideoApp(scanHandler) {
  localStorage.setItem("magicBox.openingSeen.v1", "true");
  localStorage.setItem("magicBox.activeView.v1", "videos");
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (url === "/api/config") return json({ platform: "win32", savedToolPaths: {} });
    if (url === "/api/history" || url === "/api/torrents") return json([]);
    if (url === "/api/videos/scan") return scanHandler(JSON.parse(options.body), options);
    return json({});
  }));
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  render(<App />);
  const scanButton = await screen.findByRole("button", { name: "Scan videos" });
  return { scanButton, urlInput: screen.getByLabelText("Video link, share text or BV ID") };
}

function pageProps(overrides = {}) {
  return {
    videoBrowser: "edge",
    videoUseBrowserLogin: false,
    videoCookiesFile: "",
    videoEntries: [],
    videoFilterOptions: { hosts: [], types: [] },
    videoFilters: { search: "", host: "all", type: "all", minNumber: "", maxNumber: "" },
    videoPageUrl: "https://www.douyin.com/video/1234567890",
    videoScan: { videos: [] },
    videoStatus: { tone: "idle", message: "Ready to scan." },
    visibleVideoEntries: [],
    selectedVideoKeys: new Set(),
    videoRangeSelectValue: "",
    ...overrides
  };
}

it("shows site quality and authentication warnings without hiding the cause", () => {
  const authenticationWarning = "Chrome cookies could not be decrypted. Export a Netscape cookies.txt file and scan again.";
  const qualityWarning = "BiliBili only exposed 480p. Sign in with an account that can play higher qualities.";
  render(<VideoDownloaderPage {...pageProps({
    videoScan: { videos: [], authenticationWarning, qualityWarning }
  })} />);

  expect(screen.getByText(authenticationWarning)).toBeVisible();
  expect(screen.getByText(qualityWarning)).toBeVisible();
  expect(screen.getByText(/highest available video quality is selected automatically/)).toBeVisible();
  expect(screen.queryByText(/public BiliBili formats were loaded instead/)).toBeNull();
});

it("keeps browser access opt-in and reveals the local cookie file alternative", () => {
  const onVideoCookiesFileChange = vi.fn();
  const props = pageProps({ onVideoCookiesFileChange });
  const { rerender } = render(<VideoDownloaderPage {...props} />);

  expect(screen.getByRole("checkbox", { name: /Use external browser login/ })).not.toBeChecked();
  expect(screen.getByRole("combobox", { name: "Video login browser" })).toBeDisabled();
  expect(screen.queryByLabelText("Cookies file path (optional)")).toBeNull();

  rerender(<VideoDownloaderPage {...props} videoUseBrowserLogin />);
  const cookiesInput = screen.getByLabelText("Cookies file path (optional)");
  expect(screen.getByRole("combobox", { name: "Video login browser" })).toBeEnabled();
  fireEvent.change(cookiesInput, { target: { value: "C:\\Downloads\\cookies.txt" } });
  expect(onVideoCookiesFileChange).toHaveBeenCalledWith("C:\\Downloads\\cookies.txt");

  rerender(<VideoDownloaderPage {...props} videoUseBrowserLogin videoCookiesFile="C:\\Downloads\\cookies.txt" />);
  expect(screen.getByRole("combobox", { name: "Video login browser" })).toBeDisabled();
  expect(screen.getByText(/This local file replaces the browser selection/)).toBeVisible();
});

it("sends login options only after opt-in and never persists the cookie file path", async () => {
  localStorage.setItem("magicBox.openingSeen.v1", "true");
  localStorage.setItem("magicBox.activeView.v1", "videos");
  const scanRequests = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (url === "/api/config") return json({ platform: "win32", savedToolPaths: {} });
    if (url === "/api/history" || url === "/api/torrents") return json([]);
    if (url === "/api/videos/scan") {
      const body = JSON.parse(options.body);
      scanRequests.push(body);
      return json({
        pageUrl: body.pageUrl,
        site: "douyin",
        authenticated: Boolean(body.browser || body.cookiesFile),
        authenticationMethod: body.cookiesFile ? "cookies-file" : body.browser ? "browser" : null,
        browser: body.browser,
        videos: [{ url: "https://example.com/video.mp4", filename: "video.mp4", qualityLabel: "1080p", listIndex: 1 }]
      });
    }
    return json({});
  }));
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  render(<App />);

  const scanButton = await screen.findByRole("button", { name: "Scan videos" });
  const pageUrl = "https://www.douyin.com/video/1234567890";
  fireEvent.change(screen.getByLabelText("Video link, share text or BV ID"), { target: { value: pageUrl } });

  async function scanAndWait(count) {
    fireEvent.click(scanButton);
    await waitFor(() => expect(scanRequests).toHaveLength(count));
    await waitFor(() => expect(scanButton).toBeEnabled());
  }

  await scanAndWait(1);
  expect(scanRequests[0]).toEqual({ pageUrl, browser: null });

  const loginToggle = screen.getByRole("checkbox", { name: /Use external browser login/ });
  fireEvent.click(loginToggle);
  fireEvent.change(screen.getByRole("combobox", { name: "Video login browser" }), { target: { value: "firefox" } });
  await scanAndWait(2);
  expect(scanRequests[1]).toEqual({ pageUrl, browser: "firefox" });

  const cookiesFile = "C:\\private\\site-cookies.txt";
  fireEvent.change(screen.getByLabelText("Cookies file path (optional)"), { target: { value: ` ${cookiesFile} ` } });
  await scanAndWait(3);
  expect(scanRequests[2]).toEqual({ pageUrl, browser: null, cookiesFile });
  expect(screen.getByText(/Found 1 video with the local cookies file/)).toBeVisible();
  await waitFor(() => expect(localStorage.getItem("magicBox.videoSession.v1")).not.toBeNull());
  expect(JSON.stringify(localStorage)).not.toContain("site-cookies.txt");

  fireEvent.click(loginToggle);
  await scanAndWait(4);
  expect(scanRequests[3]).toEqual({ pageUrl, browser: null });
});

it("offers verification only after a supported failure and retries the same URL explicitly", async () => {
  const requests = [];
  let finishVerification;
  const { scanButton, urlInput } = await renderVideoApp((body) => {
    requests.push(body);
    return body.verifyInBrowser ? new Promise((resolve) => { finishVerification = resolve; }) : verificationRequired();
  });
  const pageUrl = "https://example.com/protected-video";
  fireEvent.change(urlInput, { target: { value: pageUrl } });
  expect(screen.queryByRole("button", { name: "Verify in browser and retry" })).toBeNull();
  fireEvent.click(scanButton);
  const verifyButton = await screen.findByRole("button", { name: "Verify in browser and retry" });
  expect(requests[0]).toEqual({ pageUrl, browser: null });
  expect(screen.getByText(/Complete the verification in the dedicated browser window/)).toBeVisible();

  const setTimeoutSpy = vi.spyOn(window, "setTimeout");
  fireEvent.click(verifyButton);
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual({ pageUrl, browser: null, verifyInBrowser: true });
  expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 180000);
  expect(screen.getByRole("button", { name: "Waiting for verification..." })).toBeDisabled();
  expect(screen.getByText("Waiting for you to complete browser verification...")).toBeVisible();
  expect(scanButton).toBeDisabled();

  await act(async () => finishVerification(json({
    pageUrl,
    videos: [{ url: "https://example.com/verified.mp4", filename: "verified.mp4", listIndex: 1 }]
  })));
  await waitFor(() => expect(scanButton).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Verify in browser and retry" })).toBeNull();
  expect(screen.getByText("verified.mp4")).toBeVisible();
});

it("keeps a low-quality BiliBili result downloadable and offers sign-in before upgrading it", async () => {
  const requests = [];
  let finishVerification;
  const pageUrl = "https://www.bilibili.com/video/BV1rRpy6XEdM/";
  const { scanButton, urlInput } = await renderVideoApp((body) => {
    requests.push(body);
    return body.verifyInBrowser ? new Promise((resolve) => { finishVerification = resolve; }) : json({
      pageUrl,
      site: "bilibili",
      canVerifyInBrowser: true,
      verificationReason: "bilibili-login",
      verificationMessage: "Sign in to request the quality available to your account.",
      videos: [{ url: "https://example.com/480.mp4", filename: "bilibili-480.mp4", qualityLabel: "480p", listIndex: 1 }]
    });
  });
  fireEvent.change(urlInput, { target: { value: pageUrl } });
  fireEvent.click(scanButton);
  const signInButton = await screen.findByRole("button", { name: "Sign in to BiliBili and rescan" });
  expect(screen.getByText("Sign in to restore BiliBili quality")).toBeVisible();
  expect(screen.getByText("bilibili-480.mp4")).toBeVisible();
  expect(screen.getByRole("button", { name: "Download selected" })).toBeEnabled();
  expect(screen.getByText(/Your site session is saved for future scans/)).toBeVisible();
  expect(requests).toEqual([{ pageUrl, browser: null }]);

  fireEvent.click(signInButton);
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual({ pageUrl, browser: null, verifyInBrowser: true });
  expect(screen.getByRole("button", { name: "Waiting for verification..." })).toBeDisabled();
  await act(async () => finishVerification(json({
    pageUrl,
    site: "bilibili",
    authenticated: true,
    authenticationMethod: "verification-browser",
    videos: [{ url: "https://example.com/1080.mp4", filename: "bilibili-1080.mp4", qualityLabel: "1080p", listIndex: 1 }]
  })));
  await waitFor(() => expect(scanButton).toBeEnabled());
  expect(screen.getByText("bilibili-1080.mp4")).toBeVisible();
  expect(screen.queryByText("bilibili-480.mp4")).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in to BiliBili and rescan" })).toBeNull();
  expect(screen.queryByText("Sign in to restore BiliBili quality")).toBeNull();
  expect(screen.getByText(/Found 1 video with the saved site session. Highest: 1080p/)).toBeVisible();
});

it("does not offer sign-in for a successful low-quality result without a recovery flag", async () => {
  const { scanButton, urlInput } = await renderVideoApp((body) => json({
    pageUrl: body.pageUrl,
    site: "bilibili",
    videos: [{ url: "https://example.com/480.mp4", filename: "available-480.mp4", qualityLabel: "480p", listIndex: 1 }]
  }));
  fireEvent.change(urlInput, { target: { value: "https://www.bilibili.com/video/BV1rRpy6XEdM/" } });
  fireEvent.click(scanButton);
  expect(await screen.findByText("available-480.mp4")).toBeVisible();
  expect(screen.queryByLabelText("Browser verification")).toBeNull();
  expect(screen.getByRole("button", { name: "Download selected" })).toBeEnabled();
});

it("clears the external cookie override after sign-in saves a working site session", async () => {
  const requests = [];
  const pageUrl = "https://www.bilibili.com/video/BV1rRpy6XEdM/";
  let verified = false;
  const { scanButton, urlInput } = await renderVideoApp((body) => {
    requests.push(body);
    verified ||= body.verifyInBrowser === true;
    return json(verified ? {
      pageUrl,
      site: "bilibili",
      authenticated: true,
      authenticationMethod: "verification-browser",
      videos: [{ url: "https://example.com/1080.mp4", filename: "restored-1080.mp4", qualityLabel: "1080p", listIndex: 1 }]
    } : {
      pageUrl,
      site: "bilibili",
      canVerifyInBrowser: true,
      verificationReason: "bilibili-login",
      verificationMessage: "Sign in to restore the quality available to your account.",
      videos: [{ url: "https://example.com/480.mp4", filename: "stale-480.mp4", qualityLabel: "480p", listIndex: 1 }]
    });
  });
  fireEvent.change(urlInput, { target: { value: pageUrl } });
  const loginToggle = screen.getByRole("checkbox", { name: /Use external browser login/ });
  fireEvent.click(loginToggle);
  const cookiesFile = "C:\\private\\expired-cookies.txt";
  fireEvent.change(screen.getByLabelText("Cookies file path (optional)"), { target: { value: cookiesFile } });
  fireEvent.click(scanButton);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to BiliBili and rescan" }));
  await screen.findByText("restored-1080.mp4");
  await waitFor(() => expect(scanButton).toBeEnabled());
  expect(requests[0]).toEqual({ pageUrl, browser: null, cookiesFile });
  expect(requests[1]).toEqual({ pageUrl, browser: null, cookiesFile, verifyInBrowser: true });
  expect(loginToggle).not.toBeChecked();
  expect(screen.queryByLabelText("Cookies file path (optional)")).toBeNull();

  fireEvent.click(scanButton);
  await waitFor(() => expect(requests).toHaveLength(3));
  await waitFor(() => expect(scanButton).toBeEnabled());
  expect(requests[2]).toEqual({ pageUrl, browser: null });
  fireEvent.click(loginToggle);
  expect(screen.getByLabelText("Cookies file path (optional)")).toHaveValue("");
});

it.each(["VIDEO_VERIFICATION_BUSY", "VIDEO_BROWSER_UNAVAILABLE"])("offers recovery for an actionable %s response", async (code) => {
  const { scanButton, urlInput } = await renderVideoApp(() => json({
    error: "Browser verification can be retried.",
    code,
    canVerifyInBrowser: true
  }, 400));
  fireEvent.change(urlInput, { target: { value: "https://example.com/protected-video" } });
  fireEvent.click(scanButton);
  expect(await screen.findByRole("button", { name: "Verify in browser and retry" })).toBeEnabled();
});

it("does not offer verification for an ordinary HTTP error or an unsupported verification error", async () => {
  let supportedCode = false;
  const { scanButton, urlInput } = await renderVideoApp(() => json({
    error: "This page is unavailable.",
    ...(supportedCode ? { code: "VIDEO_VERIFICATION_REQUIRED", canVerifyInBrowser: false } : {})
  }, 403));
  fireEvent.change(urlInput, { target: { value: "https://example.com/unavailable" } });
  fireEvent.click(scanButton);
  await screen.findByText("This page is unavailable.");
  await waitFor(() => expect(scanButton).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Verify in browser and retry" })).toBeNull();
  supportedCode = true;
  fireEvent.click(scanButton);
  await waitFor(() => expect(scanButton).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Verify in browser and retry" })).toBeNull();
});

it("keeps verification retry available after the browser is closed or verification fails", async () => {
  const requests = [];
  const { scanButton, urlInput } = await renderVideoApp((body) => {
    requests.push(body);
    return requests.length === 1 ? verificationRequired() : json({
      error: "The verification browser was closed. Retry to open it again.",
      code: "VIDEO_VERIFICATION_REQUIRED",
      canVerifyInBrowser: true
    }, 403);
  });
  const pageUrl = "https://example.com/protected-video";
  fireEvent.change(urlInput, { target: { value: pageUrl } });
  fireEvent.click(scanButton);
  fireEvent.click(await screen.findByRole("button", { name: "Verify in browser and retry" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  const retryButton = await screen.findByRole("button", { name: "Verify in browser and retry" });
  expect(retryButton).toBeEnabled();
  expect(screen.getAllByText(/The verification browser was closed/).length).toBeGreaterThan(0);
  fireEvent.click(retryButton);
  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]).toEqual({ pageUrl, browser: null, verifyInBrowser: true });
});

it("clears the failed URL when the input changes and does not verify a different page", async () => {
  const requests = [];
  const { scanButton, urlInput } = await renderVideoApp((body) => {
    requests.push(body);
    return verificationRequired();
  });
  fireEvent.change(urlInput, { target: { value: "https://example.com/first" } });
  fireEvent.click(scanButton);
  await screen.findByRole("button", { name: "Verify in browser and retry" });
  fireEvent.change(urlInput, { target: { value: "https://example.com/second" } });
  expect(screen.queryByRole("button", { name: "Verify in browser and retry" })).toBeNull();
  fireEvent.click(scanButton);
  await screen.findByRole("button", { name: "Verify in browser and retry" });
  expect(requests[1]).toEqual({ pageUrl: "https://example.com/second", browser: null });
});

it.each(["failure", "success"])("ignores a stale %s response after the URL changes", async (outcome) => {
  let finishScan;
  let requestSignal;
  const { scanButton, urlInput } = await renderVideoApp((_body, options) => {
    requestSignal = options.signal;
    return new Promise((resolve) => { finishScan = resolve; });
  });
  fireEvent.change(urlInput, { target: { value: "https://example.com/first" } });
  fireEvent.click(scanButton);
  await waitFor(() => expect(finishScan).toBeTypeOf("function"));
  fireEvent.change(urlInput, { target: { value: "https://example.com/second" } });
  expect(requestSignal.aborted).toBe(true);
  expect(scanButton).toBeEnabled();
  await act(async () => finishScan(outcome === "failure" ? verificationRequired() : json({
    pageUrl: "https://example.com/first",
    videos: [{ url: "https://example.com/stale.mp4", filename: "stale.mp4", listIndex: 1 }]
  })));
  expect(urlInput).toHaveValue("https://example.com/second");
  expect(screen.queryByRole("button", { name: "Verify in browser and retry" })).toBeNull();
  expect(screen.queryByText("stale.mp4")).toBeNull();
});
