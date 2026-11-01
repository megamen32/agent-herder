import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupProjectWorktree, inventoryProjectWorktrees, parseWorktreePorcelain } from "../src/project-worktree-inventory.js";
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
 const root=await mkdtemp(join(tmpdir(),"herder-wt-")); dirs.push(root);
 const repo=join(root,"repo"); const worktree=join(root,"task space");
 const git=async(...args:string[]) => (await exec("git",["-C",repo,...args])).stdout.trim();
 await exec("git",["init","-q","-b","main",repo]);
 await git("config","user.email","test@example.invalid"); await git("config","user.name","Test");
 await git("commit","--allow-empty","-qm","initial");
 const head=await git("rev-parse","HEAD");
 await git("worktree","add","-qb","task",worktree);
 return {repo,worktree,git,head,request:{path:worktree,expectedHead:head,target:"main",verifiedInactive:true}};
}
describe("project worktree inventory and explicit cleanup",()=>{
 it("parses nul paths/reasons and bare/detached records without unquoting",()=>{
  const rows=parseWorktreePorcelain("worktree /one\0bare\0\0worktree /two\nspace\0HEAD abc\0detached\0locked owner reason\0prunable missing path\0\0");
  expect(rows[0].primary).toBe(true); expect(rows[0].bare).toBe(true);
  expect(rows[1]).toMatchObject({path:"/two\nspace",detached:true,locked:true,lockReason:"owner reason",prunable:true,pruneReason:"missing path"});
 });
 it("inventories a single shared project from a linked worktree",async()=>{
  const s=await setup(); const result=await inventoryProjectWorktrees(s.worktree,"main");
  expect(result.worktrees).toHaveLength(2);
  expect(result.worktrees.find(w=>w.path===s.worktree)).toMatchObject({head:s.head,branch:"refs/heads/task",dirty:false,unmerged:false,primary:false});
 });
 it("removes only clean merged inactive linked worktree and retains branch",async()=>{
  const s=await setup(); const result=await cleanupProjectWorktree(s.repo,s.request);
  expect(result.retainedBranch).toBe("refs/heads/task");
  expect(await s.git("rev-parse","task")).toBe(s.head);
  await expect(access(s.worktree)).rejects.toThrow();
  expect((await inventoryProjectWorktrees(s.repo,"main")).worktrees).toHaveLength(1);
 });
 it("denies unknown activity and explicit active owner",async()=>{
  const s=await setup();
  await expect(cleanupProjectWorktree(s.repo,{...s.request,verifiedInactive:false})).rejects.toThrow("activity");
  await expect(cleanupProjectWorktree(s.repo,{...s.request,activeOwner:"session"})).rejects.toThrow("activity");
 });
 it("denies primary worktree",async()=>{
  const s=await setup(); await expect(cleanupProjectWorktree(s.repo,{...s.request,path:s.repo})).rejects.toThrow("primary");
 });
 it("denies changed expected head",async()=>{
  const s=await setup(); await expect(cleanupProjectWorktree(s.repo,{...s.request,expectedHead:"f".repeat(40)})).rejects.toThrow("head_changed");
 });
 it("denies unmerged commits without deleting branch or data",async()=>{
  const s=await setup(); await exec("git",["-C",s.worktree,"commit","--allow-empty","-qm","unmerged"]);
  const head=(await exec("git",["-C",s.worktree,"rev-parse","HEAD"])).stdout.trim();
  await expect(cleanupProjectWorktree(s.repo,{...s.request,expectedHead:head})).rejects.toThrow("clean_and_merged");
  await access(s.worktree); expect(await s.git("rev-parse","task")).toBe(head);
 });
 it("denies dirty untracked files",async()=>{
  const s=await setup(); await writeFile(join(s.worktree,"unsaved"),"data");
  await expect(cleanupProjectWorktree(s.repo,s.request)).rejects.toThrow("clean_and_merged");
 });
 it("denies ignored files too",async()=>{
  const s=await setup(); await writeFile(join(s.repo,".git","info","exclude"),"private\n");
  await writeFile(join(s.worktree,"private"),"data");
  await expect(cleanupProjectWorktree(s.repo,s.request)).rejects.toThrow("clean_and_merged");
 });
 it("preserves newline paths on modern Git and fails closed on older Git",async()=>{
  const s=await setup(); const unusual=s.worktree+"\nextra";
  await s.git("worktree","move",s.worktree,unusual);
  try {
   const result=await inventoryProjectWorktrees(s.repo,"main");
   expect(result.worktrees.some(w=>w.path===unusual)).toBe(true);
  } catch(error) { expect(String(error)).toContain("worktree_requires_nul_capable_git"); }
  await access(unusual);
 });
 it("denies locked worktree",async()=>{
  const s=await setup(); await s.git("worktree","lock","--reason","active session",s.worktree);
  await expect(cleanupProjectWorktree(s.repo,s.request)).rejects.toThrow("locked");
 });
 it("denies foreign project and imprecise path",async()=>{
  const s=await setup(); const other=await setup();
  await expect(cleanupProjectWorktree(s.repo,{...s.request,path:other.worktree})).rejects.toThrow("not_registered");
  await expect(cleanupProjectWorktree(s.repo,{...s.request,path:s.worktree+"/../task space"})).rejects.toThrow("exact_path");
 });
 it("denies missing target and prunable entry",async()=>{
  const s=await setup();
  await expect(cleanupProjectWorktree(s.repo,{...s.request,target:"missing"})).rejects.toThrow();
  await rm(s.worktree,{recursive:true,force:true});
  const rows=(await inventoryProjectWorktrees(s.repo,"main")).worktrees;
  expect(rows.find(w=>w.path===s.worktree)?.prunable).toBe(true);
  await expect(cleanupProjectWorktree(s.repo,s.request)).rejects.toThrow("prunable");
 });
});
