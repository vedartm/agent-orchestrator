import type { Metadata } from "next";
import { PullRequestsPage } from "@/components/PullRequestsPage";
import { getDashboardPageData, getDashboardProjectName } from "@/lib/dashboard-page-data";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getDashboardProjectName();
  return { title: { absolute: `ao | ${projectName} PRs` } };
}

export default async function PullRequestsRoute() {
  const pageData = await getDashboardPageData();

  return (
    <PullRequestsPage
      initialSessions={pageData.sessions}
      projectName={pageData.projectName}
      orchestrators={pageData.orchestrators}
    />
  );
}
