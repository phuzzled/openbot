#!/usr/bin/env node
// The release notes of the fork releases (phuzzled/openbot), for the What's New dialog of the app
// and the GitHub Release. fork-release.yml runs it. See FORK-DEPLOY.md.
//
//   node scripts/fork/fork-whats-new.mjs json <tag>            The What's New entries of each fork
//                                                              release up to <tag>, as JSON.
//   node scripts/fork/fork-whats-new.mjs apply <entries> <file> Adds the entries of the JSON file
//                                                              <entries> to the bundled notes <file>.
//   node scripts/fork/fork-whats-new.mjs markdown <tag>        The notes of <tag> for its release.
//
// The notes come from git history only, so no state is committed and a sync never conflicts on them:
// a fork release has the items of each `changelog.d/*.md` file that was added or changed since the
// fork release before it (upstream files and fork files; fork items start with "Fork:"), and a
// notice that names the upstream commit and counts the upstream and fork commits. It needs the fork
// tags and the upstream refs of `scripts/fork/fork-release.sh fetch-upstream`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FORK_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const GROUPS = { added: "added", changed: "changed", fixed: "fixed", removed: "changed", security: "fixed" };
const MAX_ITEM = 240;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function lines(text) {
  return text === "" ? [] : text.split("\n");
}

function compare(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function isForkTag(tag) {
  const match = FORK_TAG.exec(tag);
  return match !== null && Number(match[3]) >= 1001;
}

/** The fork release tags up to `last`, oldest first. */
function forkTags(last) {
  const tags = lines(git("tag", "--list", "v*"))
    .filter(isForkTag)
    .sort((a, b) => compare(a.slice(1), b.slice(1)));
  const end = tags.indexOf(last);
  if (end < 0) throw new Error(`${last} is not a fork release tag.`);
  return tags.slice(0, end + 1);
}

/** The upstream refs: each upstream release tag and upstream main, when fetched. */
function upstreamRefs() {
  return lines(git("for-each-ref", "--format=%(refname)", "refs/upstream-tags", "refs/upstream/main"));
}

/** The newest upstream release tag that ref contains. */
function baseTag(ref) {
  const tags = lines(git("for-each-ref", "--format=%(refname:strip=2)", "refs/upstream-tags"))
    .filter((tag) => FORK_TAG.test(tag))
    .sort((a, b) => compare(b.slice(1), a.slice(1)));
  for (const tag of tags) {
    try {
      git("merge-base", "--is-ancestor", `refs/upstream-tags/${tag}^{commit}`, ref);
      return tag;
    } catch {}
  }
  throw new Error(`${ref} contains no upstream release. Run: scripts/fork/fork-release.sh fetch-upstream`);
}

/** The first sentence of a note item, short enough for the dialog. */
function shorten(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(\s+[A-Z(`"]|$)/.exec(flat);
  const sentence = match ? match[1] : flat;
  return sentence.length <= MAX_ITEM ? sentence : `${sentence.slice(0, MAX_ITEM - 1).trimEnd()}…`;
}

/** The groups and items of a changelog.d file at ref. */
function parseNotes(text) {
  const groups = [];
  let group = null;
  let item = null;
  for (const line of text.split("\n")) {
    const heading = /^###\s+(\w+)/.exec(line);
    if (heading) {
      group = { type: GROUPS[heading[1].toLowerCase()] ?? "changed", items: [] };
      groups.push(group);
      item = null;
    } else if (group && /^- /.test(line)) {
      item = [line.slice(2)];
      group.items.push(item);
    } else if (group && item && /^\s+\S/.test(line)) {
      item.push(line.trim());
    } else if (line.trim() === "") {
      item = null;
    }
  }
  return groups.map((g) => ({ type: g.type, items: g.items.map((i) => i.join(" ")) }));
}

/** True when a fork commit (not an upstream commit) added the file before ref. */
function isForkFile(ref, file, upstream) {
  const added = git("log", "--format=%H", "--diff-filter=A", ref, ...upstream.map((r) => `^${r}`), "--", file);
  return added !== "";
}

/** The What's New entry of the fork release `tag`, after the release `previous` (a tag or ref). */
function entry(tag, previous, upstream) {
  const version = tag.slice(1);
  const date = git("log", "-1", "--format=%cs", `${tag}^{commit}`);
  const files = lines(git("diff", "--name-only", "--diff-filter=AM", previous, `${tag}^{commit}`, "--", "changelog.d"))
    .filter((file) => file.endsWith(".md") && !file.endsWith("/README.md"))
    .sort();
  const fork = { added: [], changed: [], fixed: [] };
  const other = { added: [], changed: [], fixed: [] };
  for (const file of files) {
    const target = isForkFile(tag, file, upstream) ? fork : other;
    const prefix = target === fork ? "Fork: " : "";
    for (const group of parseNotes(git("show", `${tag}:${file}`))) {
      for (const item of group.items) target[group.type].push(prefix + shorten(item));
    }
  }
  const groups = ["added", "changed", "fixed"]
    .map((type) => ({ type, items: [...new Set([...fork[type], ...other[type]])] }))
    .filter((group) => group.items.length > 0);

  const notMain = upstream.map((r) => `^${r}`);
  const forkCommits = Number(git("rev-list", "--count", "--no-merges", `${tag}^{commit}`, `^${previous}`, ...notMain));
  const allCommits = Number(git("rev-list", "--count", "--no-merges", `${tag}^{commit}`, `^${previous}`));
  const upstreamCommits = allCommits - forkCommits;
  const base = baseTag(`${tag}^{commit}`);
  let upstreamHead = base;
  if (upstream.includes("refs/upstream/main")) {
    try {
      const head = git("merge-base", `${tag}^{commit}`, "refs/upstream/main");
      if (head !== git("rev-parse", `refs/upstream-tags/${base}^{commit}`)) upstreamHead = `main ${head.slice(0, 7)}`;
    } catch {}
  }
  const since = previous.startsWith("refs/upstream-tags/") ? `upstream ${previous.split("/").pop()}` : previous.slice(1);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const notice =
    `Fork build of OpenBot on upstream ${upstreamHead} (latest upstream release ${base}): ` +
    `${plural(upstreamCommits, "upstream change")} and ${plural(forkCommits, "fork change")} since ${since}.`;
  return { version, date, notices: [notice], groups };
}

function entries(last) {
  const upstream = upstreamRefs();
  if (upstream.length === 0) throw new Error("No upstream refs. Run: scripts/fork/fork-release.sh fetch-upstream");
  const tags = forkTags(last);
  return tags
    .map((tag, index) => entry(tag, index > 0 ? tags[index - 1] : `refs/upstream-tags/${baseTag(`${tag}^{commit}`)}`, upstream))
    .reverse();
}

function apply(entriesFile, notesFile) {
  const fork = JSON.parse(readFileSync(entriesFile, "utf8"));
  const notes = JSON.parse(readFileSync(notesFile, "utf8"));
  const versions = new Set(fork.map((e) => e.version));
  const merged = [...fork, ...notes.filter((e) => !versions.has(e.version))].sort((a, b) =>
    compare(b.version, a.version),
  );
  writeFileSync(notesFile, `${JSON.stringify(merged, null, 2)}\n`);
}

function markdown(tag) {
  const [latest] = entries(tag);
  const titles = { added: "Added", changed: "Changed", fixed: "Fixed" };
  const out = [...latest.notices, ""];
  for (const group of latest.groups) {
    out.push(`### ${titles[group.type]}`, "", ...group.items.map((item) => `- ${item}`), "");
  }
  if (latest.groups.length === 0) out.push("No new release notes in this build.", "");
  out.push(
    "Linux build of the fork `phuzzled/openbot`: upstream OpenBot (`nightly-labs/openbot`) main with the fork changes in [FORK.md](https://github.com/phuzzled/openbot/blob/main/FORK.md). Install and update: [FORK-DEPLOY.md](https://github.com/phuzzled/openbot/blob/main/FORK-DEPLOY.md).",
  );
  return out.join("\n");
}

const [command, ...args] = process.argv.slice(2);
if (command === "json" && args.length === 1) {
  process.stdout.write(`${JSON.stringify(entries(args[0]), null, 2)}\n`);
} else if (command === "apply" && args.length === 2) {
  apply(args[0], args[1]);
} else if (command === "markdown" && args.length === 1) {
  process.stdout.write(`${markdown(args[0])}\n`);
} else {
  console.error("usage: fork-whats-new.mjs json <tag> | apply <entries.json> <notes.json> | markdown <tag>");
  process.exit(1);
}
