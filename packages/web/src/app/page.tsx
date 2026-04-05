import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { DashboardShell } from "@/components/DashboardShell";
import { PortfolioPage } from "@/components/PortfolioPage";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import {
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";
import { getAllProjects } from "@/lib/project-name";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projects = getAllProjects();
  // Show "All Projects" when portfolio page will render
  if (!searchParams.project && projects.length !== 1) {
    return { title: { absolute: "ao | All Projects" } };
  }
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home() {
  const { projectSummaries, sessions, orphanedSessionCount } = await loadPortfolioPageData();

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={sessions}
      defaultLocation={getDefaultCloneLocation()}
    >
      <PortfolioPage projectSummaries={projectSummaries} orphanedSessionCount={orphanedSessionCount} />
    </DashboardShell>
  );
}
