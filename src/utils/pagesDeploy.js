import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export async function deployPagesAssets({
  directory,
  subDirName = "couplus-out",
  projectName,
  apiToken,
  accountId,
}) {
  if (!directory || !projectName || !apiToken || !accountId) {
    return { ok: false, error: "missing_config" };
  }

  const deployDir = await createDeployDir(directory, subDirName);

  const args = [
    "wrangler",
    "pages",
    "deploy",
    deployDir,
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
        resolve({ ok: true, stdout, stderr, deployDir });
      } else {
        resolve({ ok: false, error: "deploy_failed", code, stdout, stderr, deployDir });
      }
    });
  });
}

async function createDeployDir(sourceDir, subDirName) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "couplus-pages-"));
  const target = path.join(base, subDirName);
  await fs.promises.mkdir(target, { recursive: true });
  await copyDirContents(sourceDir, target);
  return base;
}

async function copyDirContents(src, dest) {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.promises.mkdir(destPath, { recursive: true });
      await copyDirContents(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}
