import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { resolveProjectConfig, type SCM, type Tracker } from "@composio/ao-core";
import { getPortfolioServices } from "@/lib/portfolio-services";
import { getServices } from "@/lib/services";

const execFileAsync = promisify(execFile);

interface PullRequestResource {
  id: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  url: string;
  updatedAt?: string;
}

interface BranchResource {
  id: string;
  name: string;
  author?: string;
  updatedAt?: string;
}

interface IssueResource {
  id: string;
  title: string;
  url: string;
  state: string;
  assignee?: string;
}

const BRANCH_FIELD_DELIMITER = "\u001f";

function matchesQuery(values: Array<string | undefined>, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(normalized));
}

function parseBranchLine(line: string): BranchResource | null {
  const [name, author, updatedAt, ...rest] = line.split(BRANCH_FIELD_DELIMITER);
  if (!name || rest.length > 0) {
    return null;
  }
  return {
    id: name,
    name,
    author: author || undefined,
    updatedAt: updatedAt || undefined,
  };
}

async function listPullRequests(
  scm: SCM | null,
  project: Parameters<NonNullable<SCM["listOpenPRs"]>>[0] | null,
  query = "",
): Promise<PullRequestResource[]> {
  if (!scm?.listOpenPRs || !project) return [];

  try {
    const prs = await scm.listOpenPRs(project, { limit: 50 });
    return prs
      .map((pr) => ({
        id: String(pr.number),
        number: pr.number,
        title: pr.title,
        author: pr.author,
        branch: pr.branch,
        url: pr.url,
        updatedAt: pr.updatedAt,
      }))
      .filter((pr) =>
        matchesQuery(
          [pr.title, `#${pr.number}`, String(pr.number), pr.author, pr.branch, pr.url],
          query,
        ),
      );
  } catch {
    return [];
  }
}

async function listBranches(repoPath: string, query = ""): Promise<BranchResource[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoPath,
        "for-each-ref",
        `--format=%(refname:short)${BRANCH_FIELD_DELIMITER}%(authorname)${BRANCH_FIELD_DELIMITER}%(committerdate:iso8601)`,
        "refs/heads",
      ],
      { timeout: 10_000 },
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseBranchLine)
      .filter((branch): branch is BranchResource => branch !== null)
      .filter((branch) => matchesQuery([branch.name, branch.author], query));
  } catch {
    return [];
  }
}

async function listIssues(
  tracker: Tracker | undefined,
  project: Parameters<NonNullable<Tracker["listIssues"]>>[1] | null,
  query = "",
): Promise<IssueResource[]> {
  if (!tracker?.listIssues || !project) return [];

  try {
    const issues = await tracker.listIssues({ state: "open", limit: 50 }, project);
    return issues
      .map((issue) => ({
        id: issue.id,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        assignee: issue.assignee,
      }))
      .filter((issue) =>
        matchesQuery([issue.title, issue.id, issue.url, issue.assignee], query),
      );
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim() ?? "";
    const portfolioProject = getPortfolioServices().portfolio.find((project) => project.id === id);

    if (!portfolioProject) {
      return NextResponse.json({ error: `Project "${id}" not found` }, { status: 404 });
    }

    const resolved = resolveProjectConfig(portfolioProject);
    if (!resolved) {
      return NextResponse.json({ error: "Project config is unavailable" }, { status: 422 });
    }

    const { registry } = await getServices();
    const scm = resolved.project.scm?.plugin
      ? (registry.get<SCM>("scm", resolved.project.scm.plugin) ?? null)
      : null;
    const tracker = resolved.project.tracker?.plugin
      ? (registry.get<Tracker>("tracker", resolved.project.tracker.plugin) ?? undefined)
      : undefined;

    const [pullRequests, branches, issues] = await Promise.all([
      listPullRequests(scm, resolved.project, query),
      listBranches(portfolioProject.repoPath, query),
      listIssues(tracker, resolved.project, query),
    ]);

    return NextResponse.json({
      project: {
        id: portfolioProject.id,
        name: portfolioProject.name,
        repo: portfolioProject.repo,
      },
      pullRequests,
      branches,
      issues,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load project resources" },
      { status: 500 },
    );
  }
}
