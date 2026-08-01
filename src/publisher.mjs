import { REGIONS } from "./api.mjs";

const APP_URL =
  "https://act.hoyolab.com/sr/event/currency-wars/index.html" +
  "?sign_type=2&auth_appid=rpqcurrencywar&authkey_ver=1&open_bbs=0" +
  "&hyl_presentation_style=fullscreen&lang=en-us#/lineup/home";

export class PublishingSessionError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PublishingSessionError";
    this.retcode = options.retcode;
    this.status = options.status;
  }
}

function findLineupId(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const key of [
    "lineup_id",
    "edit_lineup_id",
    "id",
  ]) {
    const candidate = value[key];
    if (/^[a-f0-9]{24}$/i.test(String(candidate ?? ""))) {
      return String(candidate);
    }
  }

  for (const child of Object.values(value)) {
    const candidate = findLineupId(child);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

export class BrowserSessionPublisher {
  constructor({
    profileDir,
    browserChannel = "chrome",
    headless = false,
    authRecoveryDelayMs = 8_000,
    launchPersistentContext,
  }) {
    if (!profileDir) {
      throw new TypeError("A dedicated browser profile directory is required");
    }

    this.profileDir = profileDir;
    this.browserChannel = browserChannel;
    this.headless = headless;
    this.authRecoveryDelayMs = authRecoveryDelayMs;
    this.launchPersistentContext = launchPersistentContext;
    this.context = null;
    this.page = null;
  }

  async start() {
    if (this.context) {
      return;
    }

    let launchPersistentContext = this.launchPersistentContext;
    if (!launchPersistentContext) {
      const { chromium } = await import("playwright-core");
      launchPersistentContext = chromium.launchPersistentContext.bind(
        chromium,
      );
    }

    this.context = await launchPersistentContext(this.profileDir, {
      channel: this.browserChannel,
      headless: this.headless,
      viewport: { width: 1440, height: 1000 },
    });

    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  }

  async openForLogin() {
    await this.start();
    await this.page.bringToFront();
    return new Promise((resolve) => {
      this.context.once("close", resolve);
    });
  }

  async request(path, payload, { authRecoveryAttempt = 0 } = {}) {
    await this.start();
    const endpoint = `${REGIONS.global.baseUrl}${path}`;

    const envelope = await this.page.evaluate(
      async ({ endpoint: url, payload: body }) => {
        const cookies = Object.fromEntries(
          globalThis.document.cookie
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
              const separator = part.indexOf("=");
              const name = separator < 0 ? part : part.slice(0, separator);
              const value = separator < 0 ? "" : part.slice(separator + 1);
              return [name, decodeURIComponent(value)];
            }),
        );
        const deviceId = cookies._HYVUUID ?? cookies._MHYUUID;
        if (!deviceId) {
          return { deviceIdentityAvailable: false };
        }

        const response = await globalThis.fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            "x-rpc-currencywar-tourn": "tourn",
            "x-rpc-device_id": deviceId,
            "x-rpc-lang": "en-us",
            "x-rpc-platform": "pc",
          },
          body: JSON.stringify(body),
        });

        return {
          deviceIdentityAvailable: true,
          status: response.status,
          body: await response.json(),
        };
      },
      { endpoint, payload },
    );

    if (envelope.deviceIdentityAvailable === false) {
      throw new PublishingSessionError(
        "Browser device identity is unavailable. Please log in again",
      );
    }
    if (envelope.status < 200 || envelope.status >= 300) {
      throw new PublishingSessionError(
        `Global publish API returned HTTP ${envelope.status}`,
        { status: envelope.status },
      );
    }
    if (
      envelope.body?.retcode === -100 &&
      authRecoveryAttempt === 0
    ) {
      await this.page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(this.authRecoveryDelayMs);
      return this.request(path, payload, { authRecoveryAttempt: 1 });
    }
    if (envelope.body?.retcode !== 0) {
      throw new PublishingSessionError(
        envelope.body?.message ||
          `Global publish API retcode ${envelope.body?.retcode}`,
        { retcode: envelope.body?.retcode },
      );
    }

    return envelope.body.data;
  }

  async create(payload) {
    const createdAfter = Math.floor(Date.now() / 1000) - 120;
    const data = await this.request(
      "/game/lineup/create_lineup_tourn",
      { ...payload, game: "hkrpg" },
    );
    let lineupId = findLineupId(data);
    if (!lineupId) {
      lineupId = await this.findRecentlyCreatedLineup(
        payload,
        createdAfter,
      );
    }
    if (!lineupId) {
      throw new PublishingSessionError(
        "Create succeeded but the new strategy was not found in My Posts",
      );
    }
    return { lineupId, data };
  }

  async findRecentlyCreatedLineup(payload, createdAfter) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const data = await this.request("/game/user/lineup", {
        game: "hkrpg",
        page: "1",
        limit: "20",
        lineup_type: "Tourn",
        order: "CreatedTime",
      });
      const matches = (data?.list ?? [])
        .filter(
          (lineup) =>
            lineup.title === payload.title &&
            lineup.description === payload.description &&
            Number(lineup.created_at ?? 0) >= createdAfter,
        )
        .sort(
          (left, right) =>
            Number(right.created_at ?? 0) -
            Number(left.created_at ?? 0),
        );

      if (matches[0]?.id) {
        return String(matches[0].id);
      }
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return null;
  }

  async edit(lineupId, payload) {
    await this.request("/game/lineup/edit", {
      ...payload,
      edit_lineup_id: lineupId,
      game: "hkrpg",
    });
    return { lineupId };
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }
}
