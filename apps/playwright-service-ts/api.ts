import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
} from "playwright";
import dotenv from "dotenv";
import UserAgent from "user-agents";
import { getError } from "./helpers/get_error";

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());

const BLOCK_MEDIA =
  (process.env.BLOCK_MEDIA || "False").toUpperCase() === "TRUE";

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

const AD_SERVING_DOMAINS = [
  "doubleclick.net",
  "adservice.google.com",
  "googlesyndication.com",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adsystem.com",
  "adservice.com",
  "adnxs.com",
  "ads-twitter.com",
  "facebook.net",
  "fbcdn.net",
  "amazon-adsystem.com",
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
}

let browser: Browser;

const initializeBrowser = async () => {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        // "--single-process",
        "--disable-gpu",
      ],
    });
  }
};

const createContext = async () => {
  const userAgent = new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    userAgent,
    viewport,
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = { server: PROXY_SERVER };
  }

  const context = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await context.route(
      "**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}",
      (route) => route.abort(),
    );
  }

  await context.route("**/*", (route, request) => {
    const hostname = new URL(request.url()).hostname;
    if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: "load" | "networkidle",
  waitAfterLoad: number,
  timeout: number,
  checkSelector: string | undefined,
) => {
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`,
  );
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error("Required selector not found");
    }
  }

  let headers = null,
    content = await page.content();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(
      (x) => x[0].toLowerCase() === "content-type",
    )?.[1];
    if (
      ct &&
      (ct[1].includes("application/json") || ct[1].includes("text/plain"))
    ) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
  };
};

app.get("/health", async (req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

app.post("/scrape", async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 15000,
    headers,
    check_selector,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : "None"}`);
  console.log(`Check Selector: ${check_selector ? check_selector : "None"}`);
  console.log(`==================================================`);
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "URL is invalid or missing" });
  }

  await initializeBrowser();
  const context = await createContext(); // Create context outside the try block

  try {
    const page = await context.newPage();
    if (headers) {
      await page.setExtraHTTPHeaders(headers);
    }

    let result: Awaited<ReturnType<typeof scrapePage>>;

    try {
      // Strategy 1: Normal load
      console.log("Attempting strategy 1: Normal load");
      result = await scrapePage(
        page,
        url,
        "load",
        wait_after_load,
        timeout,
        check_selector,
      );
    } catch (error) {
      console.log(
        "Strategy 1 failed, attempting strategy 2: Wait until networkidle",
      );
      // Strategy 2: Wait until networkidle
      // Note: Reusing the 'page' object after a failure can be risky, but we'll keep it for now.
      // A more advanced implementation might create a new page for the retry.
      result = await scrapePage(
        page,
        url,
        "networkidle",
        wait_after_load,
        timeout,
        check_selector,
      );
    }

    const pageError =
      result.status !== 200 ? getError(result.status) : undefined;
    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.status} ${pageError}`,
      );
    }

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      ...(pageError && { pageError }),
    });
  } catch (finalError) {
    // This catches errors from both strategies
    console.error("Both scraping strategies failed.", finalError);
    return res
      .status(500)
      .json({ error: "An error occurred while fetching the page." });
  } finally {
    // This block ALWAYS runs, ensuring the context is closed.
    if (context) {
      await context.close();
    }
  }
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`);
  });
});

process.on("SIGINT", () => {
  shutdownBrowser().then(() => {
    console.log("Browser closed");
    process.exit(0);
  });
});
