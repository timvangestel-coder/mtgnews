#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, relative } from "path";

const root = process.cwd();
const excludeDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "data",
  "test-results",
]);

// Extensions to skip entirely (config, docs, binary)
const skipExts = new Set([
  // Docs / config
  "md", "json", "lock", "yml", "yaml", "toml", "xml",
  // Binary / images
  "png", "jpg", "jpeg", "gif", "svg", "ico", "bmp",
  "zip", "tar", "gz", "rar",
  // Database binaries
  "db", "sqlite", "sqlite3", "wal", "shm",
  "pdf", "doc", "docx",
  // Compiled / binary
  "exe", "node", "pdb", "iobj", "obj",
]);

function shouldSkip(file, dirParts) {
  const ext = file.split(".").pop().toLowerCase();
  if (skipExts.has(ext)) return true;
  if (dirParts.some((p) => excludeDirs.has(p))) return true;
  // Skip hidden files and env files
  if (file.startsWith(".") || file === ".env") return true;
  // Skip the output file itself
  if (file === "ranking.md") return true;
  return false;
}

function countLines(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function walk(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(root, fullPath);
    // Split on both / and \ to handle Windows paths
    const parts = relPath.split(/[\/\\]/);

    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (!shouldSkip(entry.name, parts)) {
      const lines = countLines(fullPath);
      results.push({ path: relative(root, fullPath), lines });
    }
  }
  return results;
}

const files = walk(root).sort((a, b) => b.lines - a.lines);

let md = "# File Ranking by Line Count\n\n";
md += `Total files scanned: **${files.length}**\n\n`;
md += "| Rank | File | Lines |\n";
md += "|------|------|-------|\n";

let totalLines = 0;
files.forEach((f, i) => {
  md += `| ${i + 1} | \`${f.path}\` | ${f.lines} |\n`;
  totalLines += f.lines;
});

md += `\n---\n\n**Total lines across all files: ${totalLines}**\n`;

writeFileSync("ranking.md", md, "utf-8");
console.log(`Ranked ${files.length} files → ranking.md`);