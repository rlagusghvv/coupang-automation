import { spawn } from "node:child_process";

export async function deployPagesAssets({
  directory,
  projectName,
  apiToken,
  accountId,
}) {
  if (!directory || !projectName || !apiToken || !accountId) {
    return { ok: false, error: "missing_config" };
  }

  const args = [
    "wrangler",
    "pages",
    "deploy",
    directory,
    "--project-name",
    projectName,
  ];

  return new Promise((resolve) => {
    const child = spawn("npx", args, {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: apiToken,
        CLOUDFLARE_ACCOUNT_ID: accountId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        resolve({ ok: false, error: "deploy_failed", code, stdout, stderr });
      }
    });
  });
}
