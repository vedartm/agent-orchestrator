import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { ActivityFeedPage } from "@/components/ActivityFeedPage";
import { DashboardShell } from "@/components/DashboardShell";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadHomeActivityData } from "@/lib/home-activity-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";

export const metadata: Metadata = {
  title: { absolute: "ao | Activity" },
};

export default async function ActivityPage() {
  const [{ projectSummaries, sessions }, { activityItems }] = await Promise.all([
    loadPortfolioPageData(),
    loadHomeActivityData(),
  ]);

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={sessions}
      defaultLocation={getDefaultCloneLocation()}
    >
      <ActivityFeedPage projectSummaries={projectSummaries} activityItems={activityItems} />
    </DashboardShell>
  );
}
