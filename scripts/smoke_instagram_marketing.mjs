#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function extractSessionCookie(response) {
  const raw = response.headers.get("set-cookie") || "";
  const match = raw.match(/(^|,|;)\s*(session=[^;]+)/i);
  return match?.[2]?.trim() || match?.[1]?.trim() || "";
}

async function requestJson(baseUrl, route, {
  method = "GET",
  cookie = "",
  body,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  return { response, json };
}

async function waitForServer(baseUrl, child, logBufferRef) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n${logBufferRef.value}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/me`, { redirect: "manual" });
      if (response.status === 401 || response.status === 200) {
        return;
      }
    } catch {
      // server is still starting
    }
    await delay(200);
  }
  throw new Error(`server did not become ready\n${logBufferRef.value}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 30; i += 1) {
    if (child.exitCode !== null) return;
    await delay(100);
  }
  child.kill("SIGKILL");
}

async function poll(fn, { timeoutMs = 5000, intervalMs = 150 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw lastError || new Error("poll timeout");
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must not be empty`);
}

async function main() {
  const repoRoot = process.cwd();
  const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "couplephant-smoke-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = { value: "" };

  const server = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      COUPLEPHANT_DATA_DIR: tempDataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const appendLog = (chunk) => {
    serverLog.value += String(chunk || "");
    if (serverLog.value.length > 12000) {
      serverLog.value = serverLog.value.slice(-12000);
    }
  };
  server.stdout.on("data", appendLog);
  server.stderr.on("data", appendLog);

  try {
    await waitForServer(baseUrl, server, serverLog);

    const email = `smoke-${Date.now()}@example.com`;
    const password = `smoke-pass-${Date.now()}`;

    const signup = await requestJson(baseUrl, "/api/signup", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(signup.response.status, 200, `signup failed: ${JSON.stringify(signup.json)}`);
    const cookie = extractSessionCookie(signup.response);
    assertNonEmptyString(cookie, "session cookie");

    const igStatus = await requestJson(baseUrl, "/api/instagram/connection/status", {
      cookie,
    });
    assert.equal(igStatus.response.status, 200, "instagram status route should return 200");
    assert.equal(igStatus.json.ok, true, "instagram status should be ok=true");
    assert.equal(igStatus.json.connected, false, "instagram status should stay disconnected without settings");
    assert.equal(igStatus.json.reason, "missing_settings", "instagram status should explain missing settings");

    const targetUrl = "https://example.com/products/smoke-instagram";
    const linkCreate = await requestJson(baseUrl, "/api/marketing/links", {
      method: "POST",
      cookie,
      body: {
        targetUrl,
        sourceUrl: "https://domeggook.com/item/smoke-instagram-1",
        title: "Smoke marketing item",
        platform: "instagram",
        campaign: "smoke_instagram",
        content: "smoke_card",
        term: "smoke",
      },
    });
    assert.equal(linkCreate.response.status, 200, `marketing link create failed: ${JSON.stringify(linkCreate.json)}`);
    assert.equal(linkCreate.json.ok, true, "marketing link create should return ok=true");
    const link = linkCreate.json.link || {};
    assertNonEmptyString(link.slug, "marketing slug");
    assert.equal(link.targetUrl, targetUrl, "marketing targetUrl should round-trip");
    assert.ok(String(link.trackingPath || "").startsWith("/go/m/"), "trackingPath should point to /go/m/:slug");
    assert.ok(String(link.trackingUrl || "").startsWith(baseUrl), "trackingUrl should be absolute for local server");

    const redirect = await fetch(
      `${baseUrl}/go/m/${encodeURIComponent(link.slug)}?utm_source=instagram&utm_medium=reel&utm_campaign=smoke_instagram`,
      {
        redirect: "manual",
        headers: {
          referer: "https://www.instagram.com/reel/smoke",
          "user-agent": "couplephant-smoke-test/1.0",
        },
      },
    );
    assert.equal(redirect.status, 302, "public redirect should return 302");
    assert.equal(redirect.headers.get("location"), targetUrl, "public redirect should preserve target URL");

    const clicks = await poll(async () => {
      const clickJson = await requestJson(
        baseUrl,
        `/api/marketing/links/${encodeURIComponent(link.slug)}/clicks?limit=5`,
        { cookie },
      );
      const total = Number(clickJson.json.total || 0);
      if (total < 1) {
        throw new Error("click not recorded yet");
      }
      return clickJson.json;
    });
    assert.ok(Number(clicks.total || 0) >= 1, "click aggregation should reflect redirected visit");

    const reelsPack = await requestJson(baseUrl, "/api/marketing/reels/pack", {
      method: "POST",
      cookie,
      body: {
        platform: "instagram",
        campaign: "smoke_reels_pack",
        brand: "Smoke Brand",
        tone: "실용적",
        autoCreateLinks: true,
        items: [
          {
            title: "차량용 틈새 수납 정리함",
            keyword: "차량 수납",
            sourceUrl: "https://domeggook.com/item/smoke-instagram-2",
            targetUrl: "https://example.com/products/smoke-reels",
            category: "차량 수납",
            finalPrice: 19900,
            sourcePrice: 9900,
            marginRate: 0.28,
          },
        ],
      },
    });
    assert.equal(reelsPack.response.status, 200, `reels pack failed: ${JSON.stringify(reelsPack.json)}`);
    assert.equal(reelsPack.json.ok, true, "reels pack should return ok=true");
    assert.equal(reelsPack.json.count, 1, "reels pack should return exactly one item");
    const reelsItem = Array.isArray(reelsPack.json.items) ? reelsPack.json.items[0] || {} : {};
    const tracking = reelsItem.tracking || {};
    const pack = reelsItem.pack || {};
    assertNonEmptyString(tracking.slug, "reels tracking slug");
    assertNonEmptyString(tracking.trackingUrl, "reels tracking URL");
    assert.ok(Array.isArray(pack.hooks) && pack.hooks.length >= 3, "reels pack should include hook candidates");
    assert.ok(Array.isArray(pack.storyboards) && pack.storyboards.length >= 3, "reels pack should include storyboard variants");
    assert.ok(Array.isArray(pack.captions) && pack.captions.length >= 3, "reels pack should include captions");
    assert.ok(Array.isArray(pack.hashtags) && pack.hashtags.length >= 3, "reels pack should include hashtags");
    assertNonEmptyString(pack.instagramPostText, "reels pack should include instagram post text");
    assertNonEmptyString(pack.commentReplyTemplate, "reels pack should include comment reply template");
    assertNonEmptyString(pack.dmReplyTemplate, "reels pack should include dm reply template");
    assert.ok(Array.isArray(pack.referenceImageGuide) && pack.referenceImageGuide.length >= 3, "reels pack should include reference image guide");
    assert.ok(Array.isArray(pack.productFeatureHints) && pack.productFeatureHints.length >= 1, "reels pack should include product feature hints");
    assert.ok(Array.isArray(pack.bgmSearchKeywords) && pack.bgmSearchKeywords.length >= 3, "reels pack should include bgm search keywords");
    assertNonEmptyString(pack.bgmGuideText, "reels pack should include bgm guide text");
    assert.ok(
      Array.isArray(pack.soraVideoPrompts) && pack.soraVideoPrompts.length >= 3,
      "reels pack should include Sora prompts",
    );
    assert.ok(
      Array.isArray(pack.grokVideoPrompts) && pack.grokVideoPrompts.length >= 3,
      "reels pack should include legacy Grok-compatible prompts",
    );

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      instagramStatus: {
        connected: igStatus.json.connected,
        reason: igStatus.json.reason,
      },
      marketing: {
        slug: link.slug,
        redirectStatus: redirect.status,
        clickTotal: clicks.total,
      },
      reelsPack: {
        count: reelsPack.json.count,
        slug: tracking.slug,
        hookCount: pack.hooks.length,
      },
    }, null, 2));
  } catch (error) {
    const message = String(error?.stack || error?.message || error);
    throw new Error(`${message}\n\n[server log tail]\n${serverLog.value}`);
  } finally {
    await stopServer(server);
    await fs.rm(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error));
  process.exit(1);
});
