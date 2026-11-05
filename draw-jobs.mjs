// 画图任务落盘：重启后恢复未完成的任务；已发完成语的任务只补图，不重复发文字。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const FILE = "draw-jobs.json";

export function jobsPath(dir) { return join(dir, FILE); }
export function readJobs(dir) {
  try {
    const p = jobsPath(dir);
    if (!existsSync(p)) return [];
    const list = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export function writeJobs(dir, jobs) {
  try {
    mkdirSync(dir, { recursive: true });
    const p = jobsPath(dir);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(jobs, null, 1));
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}
export function upsertJob(dir, job) {
  const jobs = readJobs(dir);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i < 0) jobs.push(job); else jobs[i] = { ...jobs[i], ...job };
  return writeJobs(dir, jobs);
}
export function updateJob(dir, id, patch) {
  const jobs = readJobs(dir);
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;
  jobs[i] = { ...jobs[i], ...patch };
  writeJobs(dir, jobs);
  return jobs[i];
}
export function pruneJobs(dir, { keep = 50, ttlMs = 7 * 24 * 3600_000, now = Date.now } = {}) {
  const jobs = readJobs(dir).filter((j) => {
    if (j.state === "done" || j.state === "failed") return now - Number(j.updatedAt ?? j.createdAt ?? 0) <= ttlMs;
    return true;
  }).slice(-keep);
  writeJobs(dir, jobs);
  return jobs;
}
export function targetOf(chatKey) {
  const s = String(chatKey);
  if (s.startsWith("g:")) return { group_id: Number(s.slice(2)) };
  if (s.startsWith("p:")) return { user_id: Number(s.slice(2)) };
  return null;
}
